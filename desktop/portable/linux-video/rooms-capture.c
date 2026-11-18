#include <errno.h>
#include <fcntl.h>
#include <string.h>
#include <unistd.h>

#include <gst/base/gstpushsrc.h>
#include <gst/video/video.h>
#include <pipewire/pipewire.h>
#include <spa/param/param.h>
#include <spa/param/video/format-utils.h>
#include <spa/pod/builder.h>

#define ROOMS_MAX_DIMENSION 8192
#define ROOMS_MAX_FRAME_BYTES (64u * 1024u * 1024u)
#define ROOMS_KEEPALIVE_US 125000

typedef struct {
    GstPushSrc parent;
    gint portal_fd;
    guint node;
    guint64 serial;
    struct pw_thread_loop *loop;
    struct pw_context *context;
    struct pw_core *core;
    struct pw_stream *stream;
    struct spa_hook core_listener;
    struct spa_hook stream_listener;
    GstVideoInfo format;
    GstCaps *capture_caps;
    GMutex lock;
    GCond updated;
    GstBuffer *latest;
    GstCaps *latest_caps;
    GstCaps *announced_caps;
    gboolean fresh;
    gboolean flushing;
    const gchar *failure;
} RoomsCapture;

typedef GstPushSrcClass RoomsCaptureClass;

G_DEFINE_TYPE(RoomsCapture, rooms_capture, GST_TYPE_PUSH_SRC)

enum {
    PROPERTY_FD = 1,
    PROPERTY_NODE,
    PROPERTY_SERIAL,
};

static GstStaticPadTemplate source_template = GST_STATIC_PAD_TEMPLATE(
    "src", GST_PAD_SRC, GST_PAD_ALWAYS,
    GST_STATIC_CAPS("video/x-raw,format=(string){BGRx,BGRA,RGBx,RGBA},"
                    "width=(int)[1,8192],height=(int)[1,8192],framerate=(fraction)[0/1,60/1]"));

static void fail_capture(RoomsCapture *source, const gchar *message)
{
    g_mutex_lock(&source->lock);
    if (!source->failure)
        source->failure = message;
    g_cond_signal(&source->updated);
    g_mutex_unlock(&source->lock);
}

static void core_error(void *data, uint32_t id, int sequence, int result, const char *message)
{
    (void)sequence;
    (void)message;
    if (id == PW_ID_CORE || result == -EPIPE)
        fail_capture(data, "The compositor disconnected the selected PipeWire source");
}

static void stream_state(void *data, enum pw_stream_state previous, enum pw_stream_state state, const char *error)
{
    (void)error;
    if (state == PW_STREAM_STATE_ERROR ||
        (state == PW_STREAM_STATE_UNCONNECTED && previous != PW_STREAM_STATE_UNCONNECTED))
        fail_capture(data, "The selected PipeWire source became unavailable");
}

static GstVideoFormat video_format(uint32_t format)
{
    switch (format) {
    case SPA_VIDEO_FORMAT_BGRx: return GST_VIDEO_FORMAT_BGRx;
    case SPA_VIDEO_FORMAT_BGRA: return GST_VIDEO_FORMAT_BGRA;
    case SPA_VIDEO_FORMAT_RGBx: return GST_VIDEO_FORMAT_RGBx;
    case SPA_VIDEO_FORMAT_RGBA: return GST_VIDEO_FORMAT_RGBA;
    default: return GST_VIDEO_FORMAT_UNKNOWN;
    }
}

static void stream_format(void *data, uint32_t id, const struct spa_pod *param)
{
    RoomsCapture *source = data;
    struct spa_video_info_raw negotiated = {0};
    uint32_t media_type, media_subtype;
    GstVideoFormat format;

    if (id != SPA_PARAM_Format)
        return;
    gst_clear_caps(&source->capture_caps);
    g_mutex_lock(&source->lock);
    gst_clear_caps(&source->latest_caps);
    gst_clear_buffer(&source->latest);
    source->fresh = FALSE;
    g_cond_signal(&source->updated);
    g_mutex_unlock(&source->lock);
    if (!param)
        return;
    if (spa_format_parse(param, &media_type, &media_subtype) < 0 ||
        media_type != SPA_MEDIA_TYPE_video || media_subtype != SPA_MEDIA_SUBTYPE_raw ||
        spa_format_video_raw_parse(param, &negotiated) < 0 ||
        (format = video_format(negotiated.format)) == GST_VIDEO_FORMAT_UNKNOWN ||
        !negotiated.size.width || !negotiated.size.height ||
        negotiated.size.width > ROOMS_MAX_DIMENSION || negotiated.size.height > ROOMS_MAX_DIMENSION ||
        (guint64)negotiated.size.width * negotiated.size.height * 4 > ROOMS_MAX_FRAME_BYTES ||
        (negotiated.flags & SPA_VIDEO_FLAG_MODIFIER)) {
        fail_capture(source, "The compositor did not provide a supported shared-memory video format");
        return;
    }

    gst_video_info_set_format(&source->format, format, negotiated.size.width, negotiated.size.height);
    if (negotiated.framerate.denom && negotiated.framerate.denom <= G_MAXINT &&
        negotiated.framerate.num <= G_MAXINT &&
        (guint64)negotiated.framerate.num <= 60u * (guint64)negotiated.framerate.denom) {
        source->format.fps_n = negotiated.framerate.num;
        source->format.fps_d = negotiated.framerate.denom;
    }
    source->capture_caps = gst_video_info_to_caps(&source->format);

    uint8_t storage[512];
    struct spa_pod_builder builder = SPA_POD_BUILDER_INIT(storage, sizeof(storage));
    const struct spa_pod *buffers = spa_pod_builder_add_object(&builder,
        SPA_TYPE_OBJECT_ParamBuffers, SPA_PARAM_Buffers,
        SPA_PARAM_BUFFERS_buffers, SPA_POD_CHOICE_RANGE_Int(4, 2, 8),
        SPA_PARAM_BUFFERS_blocks, SPA_POD_Int(1),
        SPA_PARAM_BUFFERS_size, SPA_POD_Int((int)source->format.size),
        SPA_PARAM_BUFFERS_stride, SPA_POD_Int(source->format.stride[0]),
        SPA_PARAM_BUFFERS_dataType, SPA_POD_CHOICE_FLAGS_Int((1 << SPA_DATA_MemFd) | (1 << SPA_DATA_MemPtr)));
    if (pw_stream_update_params(source->stream, &buffers, 1) < 0)
        fail_capture(source, "PipeWire could not allocate shared-memory video buffers");
}

static GstBuffer *copy_frame(RoomsCapture *source, const struct spa_buffer *buffer)
{
    if (!source->capture_caps || !buffer || buffer->n_datas != 1)
        return NULL;
    const struct spa_data *plane = buffer->datas;
    const struct spa_chunk *chunk = plane->chunk;
    guint stride = GST_VIDEO_INFO_PLANE_STRIDE(&source->format, 0);
    guint height = GST_VIDEO_INFO_HEIGHT(&source->format);
    if (!plane->data || !chunk ||
        (plane->type != SPA_DATA_MemFd && plane->type != SPA_DATA_MemPtr) ||
        (chunk->flags & (SPA_CHUNK_FLAG_CORRUPTED | SPA_CHUNK_FLAG_EMPTY)) ||
        chunk->stride < (int32_t)stride || chunk->offset >= plane->maxsize ||
        chunk->size > plane->maxsize - chunk->offset ||
        (guint64)(height - 1) * chunk->stride + stride > chunk->size)
        return NULL;

    GstBuffer *frame = gst_buffer_new_allocate(NULL, source->format.size, NULL);
    if (!frame)
        return NULL;
    GstMapInfo output;
    if (!gst_buffer_map(frame, &output, GST_MAP_WRITE)) {
        gst_buffer_unref(frame);
        return NULL;
    }
    const guint8 *pixels = (const guint8 *)plane->data + chunk->offset;
    if ((guint)chunk->stride == stride) {
        memcpy(output.data, pixels, source->format.size);
    } else {
        for (guint row = 0; row < height; row++)
            memcpy(output.data + (gsize)row * stride, pixels + (gsize)row * chunk->stride, stride);
    }
    gst_buffer_unmap(frame, &output);
    return frame;
}

static void stream_process(void *data)
{
    RoomsCapture *source = data;
    struct pw_buffer *frame = NULL;
    struct pw_buffer *next;
    while ((next = pw_stream_dequeue_buffer(source->stream))) {
        if (frame)
            pw_stream_queue_buffer(source->stream, frame);
        frame = next;
    }
    if (!frame)
        return;

    GstBuffer *copy = copy_frame(source, frame->buffer);
    pw_stream_queue_buffer(source->stream, frame);
    if (!copy)
        return;

    g_mutex_lock(&source->lock);
    gst_buffer_replace(&source->latest, copy);
    gst_caps_replace(&source->latest_caps, source->capture_caps);
    source->fresh = TRUE;
    g_cond_signal(&source->updated);
    g_mutex_unlock(&source->lock);
    gst_buffer_unref(copy);
}

static const struct pw_core_events core_events = {
    PW_VERSION_CORE_EVENTS,
    .error = core_error,
};

static const struct pw_stream_events stream_events = {
    PW_VERSION_STREAM_EVENTS,
    .state_changed = stream_state,
    .param_changed = stream_format,
    .process = stream_process,
};

static gboolean stop_capture(GstBaseSrc *base)
{
    RoomsCapture *source = (RoomsCapture *)base;
    if (source->loop) {
        pw_thread_loop_stop(source->loop);
        if (source->stream) {
            spa_hook_remove(&source->stream_listener);
            pw_stream_destroy(source->stream);
            source->stream = NULL;
        }
        if (source->core) {
            spa_hook_remove(&source->core_listener);
            pw_core_disconnect(source->core);
            source->core = NULL;
        }
        if (source->context) {
            pw_context_destroy(source->context);
            source->context = NULL;
        }
        pw_thread_loop_destroy(source->loop);
        source->loop = NULL;
    }
    gst_clear_caps(&source->capture_caps);
    gst_clear_caps(&source->announced_caps);
    g_mutex_lock(&source->lock);
    gst_clear_caps(&source->latest_caps);
    gst_clear_buffer(&source->latest);
    source->fresh = FALSE;
    source->failure = NULL;
    source->flushing = FALSE;
    g_mutex_unlock(&source->lock);
    return TRUE;
}

static gboolean start_capture(GstBaseSrc *base)
{
    RoomsCapture *source = (RoomsCapture *)base;
    if (source->portal_fd < 0 || (!source->serial && (!source->node || source->node == PW_ID_ANY)))
        goto error;

    source->loop = pw_thread_loop_new("rooms-screen-capture", NULL);
    if (!source->loop)
        goto error;
    source->context = pw_context_new(pw_thread_loop_get_loop(source->loop), NULL, 0);
    if (!source->context)
        goto error;
    int fd = fcntl(source->portal_fd, F_DUPFD_CLOEXEC, 3);
    if (fd < 0)
        goto error;
    source->core = pw_context_connect_fd(source->context, fd, NULL, 0);
    if (!source->core)
        goto error;
    pw_core_add_listener(source->core, &source->core_listener, &core_events, source);

    struct pw_properties *properties = pw_properties_new(
        PW_KEY_MEDIA_TYPE, "Video", PW_KEY_MEDIA_CATEGORY, "Capture", PW_KEY_APP_NAME, "ZeloteZ Rooms",
        PW_KEY_NODE_DONT_RECONNECT, "true", "node.dont-fallback", "true", "node.dont-move", "true",
        "stream.restore-target", "false", NULL);
    if (!properties)
        goto error;
    if (source->serial)
        pw_properties_setf(properties, PW_KEY_TARGET_OBJECT, "%" G_GUINT64_FORMAT, source->serial);

    source->stream = pw_stream_new(source->core, "Rooms screen capture", properties);
    if (!source->stream)
        goto error;
    pw_stream_add_listener(source->stream, &source->stream_listener, &stream_events, source);
    uint8_t storage[1024];
    struct spa_pod_builder builder = SPA_POD_BUILDER_INIT(storage, sizeof(storage));
    const struct spa_rectangle preferred = SPA_RECTANGLE(1920, 1080);
    const struct spa_rectangle minimum = SPA_RECTANGLE(1, 1);
    const struct spa_rectangle maximum = SPA_RECTANGLE(ROOMS_MAX_DIMENSION, ROOMS_MAX_DIMENSION);
    const struct spa_fraction max_rate = SPA_FRACTION(60, 1);
    const struct spa_fraction variable_rate = SPA_FRACTION(0, 1);
    const struct spa_pod *format = spa_pod_builder_add_object(&builder,
        SPA_TYPE_OBJECT_Format, SPA_PARAM_EnumFormat,
        SPA_FORMAT_mediaType, SPA_POD_Id(SPA_MEDIA_TYPE_video),
        SPA_FORMAT_mediaSubtype, SPA_POD_Id(SPA_MEDIA_SUBTYPE_raw),
        SPA_FORMAT_VIDEO_format, SPA_POD_CHOICE_ENUM_Id(5,
            SPA_VIDEO_FORMAT_BGRx, SPA_VIDEO_FORMAT_BGRx, SPA_VIDEO_FORMAT_BGRA,
            SPA_VIDEO_FORMAT_RGBx, SPA_VIDEO_FORMAT_RGBA),
        SPA_FORMAT_VIDEO_size, SPA_POD_CHOICE_RANGE_Rectangle(&preferred, &minimum, &maximum),
        SPA_FORMAT_VIDEO_framerate, SPA_POD_CHOICE_RANGE_Fraction(&max_rate, &variable_rate, &max_rate),
        SPA_FORMAT_VIDEO_maxFramerate, SPA_POD_CHOICE_RANGE_Fraction(&max_rate, &variable_rate, &max_rate));
    if (pw_stream_connect(source->stream, PW_DIRECTION_INPUT, source->serial ? PW_ID_ANY : source->node,
                          PW_STREAM_FLAG_AUTOCONNECT | PW_STREAM_FLAG_MAP_BUFFERS, &format, 1) < 0 ||
        pw_thread_loop_start(source->loop) < 0)
        goto error;
    return TRUE;

error:
    stop_capture(base);
    GST_ELEMENT_ERROR(source, RESOURCE, OPEN_READ, ("The approved PipeWire screen source could not be opened"), (NULL));
    return FALSE;
}

static gboolean unlock_capture(GstBaseSrc *base)
{
    RoomsCapture *source = (RoomsCapture *)base;
    g_mutex_lock(&source->lock);
    source->flushing = TRUE;
    g_cond_signal(&source->updated);
    g_mutex_unlock(&source->lock);
    return TRUE;
}

static gboolean resume_capture(GstBaseSrc *base)
{
    RoomsCapture *source = (RoomsCapture *)base;
    g_mutex_lock(&source->lock);
    source->flushing = FALSE;
    g_mutex_unlock(&source->lock);
    return TRUE;
}

static gboolean negotiate_capture(GstBaseSrc *base)
{
    // The approved compositor source determines the actual dimensions and layout.
    (void)base;
    return TRUE;
}

static GstFlowReturn create_frame(GstPushSrc *push, GstBuffer **output)
{
    RoomsCapture *source = (RoomsCapture *)push;
    const gint64 next_keepalive = g_get_monotonic_time() + ROOMS_KEEPALIVE_US;
    g_mutex_lock(&source->lock);
    while (!source->fresh && !source->flushing && !source->failure) {
        if (source->latest) {
            if (!g_cond_wait_until(&source->updated, &source->lock, next_keepalive))
                break;
        } else {
            g_cond_wait(&source->updated, &source->lock);
        }
    }
    if (source->flushing || source->failure) {
        const gchar *failure = source->failure;
        gboolean flushing = source->flushing;
        g_mutex_unlock(&source->lock);
        if (flushing)
            return GST_FLOW_FLUSHING;
        GST_ELEMENT_ERROR(source, RESOURCE, READ, ("%s", failure), (NULL));
        return GST_FLOW_ERROR;
    }
    GstCaps *caps = gst_caps_ref(source->latest_caps);
    *output = gst_buffer_copy(source->latest);
    source->fresh = FALSE;
    g_mutex_unlock(&source->lock);
    if (!*output) {
        gst_caps_unref(caps);
        return GST_FLOW_ERROR;
    }

    gboolean negotiated = source->announced_caps == caps || gst_base_src_set_caps(GST_BASE_SRC(source), caps);
    if (negotiated)
        gst_caps_replace(&source->announced_caps, caps);
    gst_caps_unref(caps);
    if (!negotiated) {
        gst_clear_buffer(output);
        return GST_FLOW_NOT_NEGOTIATED;
    }
    return GST_FLOW_OK;
}

static void set_property(GObject *object, guint id, const GValue *value, GParamSpec *spec)
{
    RoomsCapture *source = (RoomsCapture *)object;
    switch (id) {
    case PROPERTY_FD: source->portal_fd = g_value_get_int(value); break;
    case PROPERTY_NODE: source->node = g_value_get_uint(value); break;
    case PROPERTY_SERIAL: source->serial = g_value_get_uint64(value); break;
    default: G_OBJECT_WARN_INVALID_PROPERTY_ID(object, id, spec);
    }
}

static void dispose_capture(GObject *object)
{
    RoomsCapture *source = (RoomsCapture *)object;
    stop_capture(GST_BASE_SRC(source));
    G_OBJECT_CLASS(rooms_capture_parent_class)->dispose(object);
}

static void finalize_capture(GObject *object)
{
    RoomsCapture *source = (RoomsCapture *)object;
    g_mutex_clear(&source->lock);
    g_cond_clear(&source->updated);
    G_OBJECT_CLASS(rooms_capture_parent_class)->finalize(object);
}

static void rooms_capture_class_init(RoomsCaptureClass *cls)
{
    GObjectClass *object = G_OBJECT_CLASS(cls);
    GstElementClass *element = GST_ELEMENT_CLASS(cls);
    GstBaseSrcClass *base = GST_BASE_SRC_CLASS(cls);
    object->set_property = set_property;
    object->dispose = dispose_capture;
    object->finalize = finalize_capture;
    g_object_class_install_property(object, PROPERTY_FD,
        g_param_spec_int("portal-fd", "Portal FD", "ScreenCast portal PipeWire connection",
                         -1, G_MAXINT, -1, G_PARAM_WRITABLE | G_PARAM_STATIC_STRINGS | GST_PARAM_MUTABLE_READY));
    g_object_class_install_property(object, PROPERTY_NODE,
        g_param_spec_uint("node-id", "Node ID", "Compositor-approved PipeWire node",
                          0, G_MAXUINT - 1, 0, G_PARAM_WRITABLE | G_PARAM_STATIC_STRINGS | GST_PARAM_MUTABLE_READY));
    g_object_class_install_property(object, PROPERTY_SERIAL,
        g_param_spec_uint64("node-serial", "Node serial", "Compositor-approved PipeWire object serial",
                            0, G_MAXUINT64, 0, G_PARAM_WRITABLE | G_PARAM_STATIC_STRINGS | GST_PARAM_MUTABLE_READY));
    gst_element_class_add_static_pad_template(element, &source_template);
    gst_element_class_set_static_metadata(element, "Rooms PipeWire screen capture", "Source/Video",
        "Acquire the latest approved compositor frame directly from PipeWire", "ZeloteZ Rooms");
    base->start = start_capture;
    base->stop = stop_capture;
    base->unlock = unlock_capture;
    base->unlock_stop = resume_capture;
    base->negotiate = negotiate_capture;
    GST_PUSH_SRC_CLASS(cls)->create = create_frame;
}

static void rooms_capture_init(RoomsCapture *source)
{
    source->portal_fd = -1;
    g_mutex_init(&source->lock);
    g_cond_init(&source->updated);
    gst_base_src_set_live(GST_BASE_SRC(source), TRUE);
    gst_base_src_set_format(GST_BASE_SRC(source), GST_FORMAT_TIME);
    gst_base_src_set_do_timestamp(GST_BASE_SRC(source), TRUE);
}

static gboolean plugin_init(GstPlugin *plugin)
{
    pw_init(NULL, NULL);
    return gst_element_register(plugin, "roomspipewiresrc", GST_RANK_NONE, rooms_capture_get_type());
}

#define PACKAGE "zelotez-rooms"
GST_PLUGIN_DEFINE(1, 20, roomscapture, "Rooms native Linux capture",
    plugin_init, "1.0", "Proprietary", "ZeloteZ Rooms", "https://github.com/ZeloteZ/ZeloteZ-Rooms")
