# Contributing to ZeloteZ Rooms

Bug reports and suggestions are welcome. Do not include credentials, private
messages, or other personal data in an issue or pull request.

## License and contribution rights

Public project code is offered under the
[PolyForm Noncommercial License 1.0.0](LICENSE), with the scope explained in
[LICENSING.md](LICENSING.md). ZeloteZ retains the option to release future
versions commercially or under proprietary terms.

For that reason, code, documentation, translations, and artwork can be merged
only after every relevant contributor has explicitly accepted the
[ZeloteZ Rooms Contributor License Agreement, version 1.0](CLA.md). The agreement
lets the project owner use and sublicense contributions commercially while
contributors retain their copyright. Agreement only to PolyForm Noncommercial,
or a Developer Certificate of Origin sign-off, does not provide those additional
permissions.

## Before submitting a change

1. Explain the problem and the resulting behavior in the pull request. Include
   relevant checks or screenshots when they help review the change.
2. Submit only work you have authority to contribute. Obtain any necessary
   employer or client permission first.
3. Identify third-party material, its source and its license separately. Preserve
   its notices. Do not claim to grant rights to it through the CLA.
4. Read the CLA at the pull request's base commit. Post the following statement
   from your own GitHub account in the pull request description or a comment,
   replacing the commit placeholder with that full commit ID:

   > I have read and agree to the ZeloteZ Rooms Contributor License Agreement
   > version 1.0 in CLA.md at base commit `<full commit ID>`. I accept it for my
   > contributions and revisions in this pull request and confirm that I have
   > authority to grant the rights it describes.

The GitHub **Files changed** view shows the base of the pull request; maintainers
can also retrieve its exact ID with
`gh pr view <number> --json baseRefOid --jq .baseRefOid`. Use a commit containing
the CLA version you read. If it does not, ask the maintainer to update the base
before accepting.

Each contributor must post their own statement unless an authorized
representative expressly agrees for their organization and identifies the
covered contributors. Do not publish addresses, signatures, or employer documents
in the pull request. If public acceptance is unsuitable, arrange a separately
documented agreement with the project owner before the contribution is merged.

## Maintainer review

CLA review is manual. There is no automated CLA service or enforcement bot.
Before merging any contribution:

- Confirm that every relevant rights holder is covered by documented acceptance
  and that the referenced commit contains the stated CLA version.
- Retain the acceptance link, accepted version, and commit ID in the pull request
  record. A checked template box without the completed acceptance statement is
  insufficient.
- Review third-party licenses and any employer or client authorization needed
  for the submitted work. If authority or commercial licensing rights are
  unclear, resolve them before merging.
- Review the change and run checks appropriate to it.

Do not merge substantive external contributions until the rights review is
complete. An earlier submission or acceptance of a different license must not be
treated as retroactive acceptance of this CLA.
