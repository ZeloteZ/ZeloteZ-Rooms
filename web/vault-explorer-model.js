export const VAULT_EXPLORER_ROOT = "root";
export const VAULT_EXPLORER_SHARED = "shared";
const UNKNOWN_SENDER = "unknown-sender";
const MAX_DEPTH = 32;
const MAX_COLUMNS = 4;
const empty = Object.freeze([]);
const identifier = value => typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value);
const label = (value, fallback = "") => typeof value === "string" && value.trim() ? value : fallback;
const ownRef = id => "own:" + id;
const sharedRef = id => "share:" + id;
const ready = entry => entry?.state === "ready";

// References identify records, never display names or decrypted filenames.
// The client entry remains intact so received-share capabilities reach the
// existing authenticated download/preview code without being reconstructed.
export function createVaultExplorerModel(snapshot = {}, {
  actorId = null, rootName = "Files", sharedName = "Shared With Me",
  unknownSenderName = "Unknown sender", lockedName = "Locked item",
} = {}) {
  const nodes = new Map();
  const children = new Map();
  const allChildren = new Map();
  const pathCache = new Map();
  const ownEntries = Array.isArray(snapshot.entries) ? snapshot.entries : [];
  const receivedEntries = Array.isArray(snapshot.receivedEntries) ? snapshot.receivedEntries : [];
  const actor = identifier(actorId) ? actorId : null;

  function add(node) {
    const value = Object.freeze(node);
    nodes.set(value.ref, value);
    return value;
  }
  function folder(ref, name, parentRef, ownerId = null) {
    return add({ ref, id: null, kind: "folder", name, parentRef, ownerId,
      entry: null, synthetic: true, readOnly: true, locked: false, container: true });
  }
  folder(VAULT_EXPLORER_ROOT, rootName, null);
  folder(VAULT_EXPLORER_SHARED, sharedName, VAULT_EXPLORER_ROOT);

  function unique(items, getId) {
    const counts = new Map();
    for (const item of items) {
      const id = getId(item);
      if (identifier(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return items.filter(item => identifier(getId(item)) && counts.get(getId(item)) === 1);
  }

  for (const entry of unique(ownEntries, entry => entry?.id)) {
    if (!entry || !["file", "folder"].includes(entry.kind) || entry.receivedShareId) continue;
    const owns = actor !== null && entry.ownerId === actor;
    const validParent = entry.parentId === null || entry.parentId === undefined || identifier(entry.parentId);
    add({ ref: ownRef(entry.id), id: entry.id, kind: entry.kind,
      name: label(entry.name, lockedName),
      parentRef: entry.parentId == null ? VAULT_EXPLORER_ROOT : ownRef(entry.parentId),
      ownerId: entry.ownerId, entry, synthetic: false, readOnly: !owns,
      locked: entry.locked === true || !owns || !validParent,
      container: entry.kind === "folder" });
  }

  for (const entry of unique(receivedEntries, entry => entry?.receivedShareId)) {
    const owner = entry?.share?.owner;
    const validOwner = identifier(owner?.id) && owner.id === entry.ownerId && owner.id === entry.share?.ownerId;
    const consistent = validOwner && identifier(entry.id) && entry.kind === "file" && entry.share?.id === entry.receivedShareId &&
      entry.share?.entryId === entry.id && actor !== null && entry.share?.recipientId === actor;
    const parentRef = validOwner ? "sender:" + owner.id : UNKNOWN_SENDER;
    const senderName = validOwner ? label(owner.username, label(owner.displayName, unknownSenderName)) : unknownSenderName;
    if (!nodes.has(parentRef)) folder(parentRef, senderName, VAULT_EXPLORER_SHARED, validOwner ? owner.id : null);
    add({ ref: sharedRef(entry.receivedShareId), id: entry.id, kind: "file",
      name: label(entry.name, lockedName), parentRef, ownerId: validOwner ? owner.id : null,
      entry, synthetic: false, readOnly: true, locked: entry.locked === true || !consistent,
      container: false });
  }

  function node(ref) { return typeof ref === "string" ? nodes.get(ref) ?? null : null; }
  function path(ref) {
    if (pathCache.has(ref)) return pathCache.get(ref);
    const result = [], seen = new Set();
    let cursor = node(ref);
    while (cursor) {
      if (seen.has(cursor.ref) || result.length >= MAX_DEPTH + 1) return empty;
      seen.add(cursor.ref); result.unshift(cursor);
      if (cursor.ref === VAULT_EXPLORER_ROOT) {
        const value = Object.freeze(result);
        pathCache.set(ref, value);
        return value;
      }
      const parent = node(cursor.parentRef);
      if (!parent?.container || (!cursor.synthetic && !cursor.readOnly && parent.readOnly && !parent.synthetic)) return empty;
      cursor = parent;
    }
    return empty;
  }

  for (const item of nodes.values()) {
    if (item.ref === VAULT_EXPLORER_ROOT) continue;
    if (node(item.parentRef)?.container) {
      const all = allChildren.get(item.parentRef) ?? [];
      all.push(item); allChildren.set(item.parentRef, all);
    }
    if (!path(item.ref).length) continue;
    if (item.entry && !ready(item.entry)) continue;
    const entries = children.get(item.parentRef) ?? [];
    entries.push(item); children.set(item.parentRef, entries);
  }
  for (const [ref, items] of allChildren) allChildren.set(ref, Object.freeze(items));
  for (const [ref, items] of children) {
    items.sort((a, b) => Number(b.container) - Number(a.container) ||
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) || a.ref.localeCompare(b.ref));
    // Keep the virtual Shared folder discoverable even among many own folders.
    if (ref === VAULT_EXPLORER_ROOT) items.sort((a, b) => Number(b.ref === VAULT_EXPLORER_SHARED) - Number(a.ref === VAULT_EXPLORER_SHARED));
    children.set(ref, Object.freeze(items));
  }
  return Object.freeze({ actorId: actor, rootRef: VAULT_EXPLORER_ROOT, sharedRef: VAULT_EXPLORER_SHARED,
    node, path, children: (ref, { includeUploading = false } = {}) => node(ref)?.container
      ? (includeUploading ? allChildren : children).get(ref) ?? empty : empty });
}

function navigablePath(model, ref) {
  const node = model.node(ref);
  if (!node?.container || node.locked) return empty;
  const path = model.path(ref);
  return path.length && path.every(item => item.container && !item.locked && (!item.entry || ready(item.entry))) ? path : empty;
}

function navigation(model, refs) {
  if (Array.isArray(refs)) {
    for (let index = Math.min(refs.length, 256) - 1; index >= 0; index -= 1) {
      const path = navigablePath(model, refs[index]);
      if (path.length) return path;
    }
  }
  return model.path(VAULT_EXPLORER_ROOT);
}

export function vaultExplorerView(model, navigationRefs = []) {
  const breadcrumbs = navigation(model, navigationRefs);
  const refs = Object.freeze(breadcrumbs.map(item => item.ref));
  const visible = breadcrumbs.length <= MAX_COLUMNS ? breadcrumbs :
    [...breadcrumbs.slice(0, MAX_COLUMNS - 1), breadcrumbs[breadcrumbs.length - 1]];
  const columns = visible.map(item => {
    const index = breadcrumbs.indexOf(item);
    return Object.freeze({ ref: item.ref, node: item, items: model.children(item.ref),
      selectedRef: breadcrumbs[index + 1]?.ref ?? null });
  });
  return Object.freeze({ path: refs, breadcrumbs, selected: breadcrumbs[breadcrumbs.length - 1],
    columns: Object.freeze(columns) });
}

export function navigateVaultExplorer(model, currentRefs, targetRef) {
  const path = navigablePath(model, targetRef);
  return Object.freeze((path.length ? path : navigation(model, currentRefs)).map(item => item.ref));
}

// This validates references against the current model, never the drag payload's
// object properties. The caller must pass its current account again immediately
// before the existing client/server mutation; this is not a server auth boundary.
export function validateVaultExplorerMove(model, sourceRef, destinationRef, { actorId } = {}) {
  const reject = reason => Object.freeze({ ok: false, reason });
  if (!identifier(actorId) || actorId !== model.actorId) return reject("actor-changed");
  const source = model.node(sourceRef), destination = model.node(destinationRef);
  if (!source) return reject("source-unavailable");
  if (source.synthetic || source.readOnly || source.entry?.receivedShareId) return reject("read-only");
  function sameIdentity(item) {
    const entry = item?.entry;
    return item && !item.synthetic && !item.readOnly && entry &&
      !entry.receivedShareId && entry.ownerId === actorId &&
      entry.id === item.id && entry.kind === item.kind &&
      (entry.parentId == null ? VAULT_EXPLORER_ROOT : ownRef(entry.parentId)) === item.parentRef;
  }
  const currentOwn = item => sameIdentity(item) && !item.locked && ready(item.entry) && item.entry.locked !== true;
  const sourcePath = model.path(sourceRef);
  if (!currentOwn(source) || !sourcePath.length || sourcePath.some(item => !item.synthetic && !currentOwn(item))) return reject("source-unavailable");
  if (!destination?.container) return reject("destination-unavailable");
  if (destinationRef !== VAULT_EXPLORER_ROOT && !currentOwn(destination)) return reject("read-only-destination");
  const destinationPath = navigablePath(model, destinationRef);
  if (!destinationPath.length || destinationPath.some(item => !item.synthetic && !currentOwn(item))) return reject("destination-unavailable");
  if (sourceRef === destinationRef) return reject("self");
  if (destinationPath.some(item => item.ref === sourceRef)) return reject("cycle");
  if (source.parentRef === destinationRef) return reject("same-parent");
  // Count the entire subtree, including in-progress children, so moving a
  // folder cannot exceed the server's 32-level limit once an upload completes.
  let height = 0;
  const stack = [[sourceRef, 0]], seen = new Set();
  while (stack.length) {
    const [ref, depth] = stack.pop();
    if (seen.has(ref) || depth > MAX_DEPTH) return reject("invalid-tree");
    seen.add(ref); height = Math.max(height, depth);
    for (const child of model.children(ref, { includeUploading: true })) {
      if (!sameIdentity(child)) return reject("invalid-tree");
      stack.push([child.ref, depth + 1]);
    }
  }
  if (destinationPath.length + height > MAX_DEPTH) return reject("too-deep");
  return Object.freeze({ ok: true, reason: null, entry: source.entry,
    parentId: destinationRef === VAULT_EXPLORER_ROOT ? null : destination.id });
}
