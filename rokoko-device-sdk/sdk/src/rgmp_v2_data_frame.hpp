#pragma once

#include "rgmp_v2_basic_types.hpp"
#include "rgmp_v2_stream_definition_frame.hpp"
#include "rgmp_v2_type_system.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <type_traits>
#include <utility>
#include <vector>

namespace rkk::rgmp::v2 {

struct data_frame_header {
    uint32_t device_id{0};
    uint32_t group_id{0};
    uint64_t timestamp_us{0};
};

// Guards against accidental field additions; not a wire-layout guarantee.
static_assert(sizeof(data_frame_header) == 16);

void write_data_frame_header(
    data_frame_header const& h,
    std::span<std::byte, 16> out
);
[[nodiscard]] data_frame_header
read_data_frame_header(std::span<std::byte const, 16> in);

[[nodiscard]] size_t
group_payload_size_bytes(stream_definition_frame const& frame, uint32_t group_id);

// Per-stream slice of a Data Frame's payload.
//
// `entry` points into `frame.groups[group_id].streams` of the source
// stream_definition_frame; `bytes` points into the caller's payload buffer.
// The view is valid only as long as both the source frame and the payload
// buffer outlive it.
struct data_frame_stream_view {
    base_data_entry const*     entry;
    std::span<std::byte const> bytes;
};

struct data_frame_stream_view_mut {
    base_data_entry const* entry;
    std::span<std::byte>   bytes;
};

class data_frame_writer;

// Per-group lookup keyed by (measure_type, target_frame, custom_label).
// Borrows pointers into the source frame's base_data_entry objects; the source
// frame must outlive the index (same lifetime contract as
// data_frame_stream_view).
//
// Built once from a frame+group_id at producer setup time, then queried per
// data frame to resolve a stream slice by name. Replaces positional indexing
// of `data_frame_stream_views(...)[i]`, which is silently wrong if the
// definition reorders streams.
//
// device_id is captured by value at construction. Mutating frame.device_id
// after the index is built does NOT affect data_frame_writer's inner header —
// rebuild the index if you change device_id.
class group_layout {
  public:
    // Throws rkk::rgmp::v2::error  if group_id is out of bounds.
    // Throws rkk::rgmp::v2::error if two streams share the same
    //   (measure_type, target_frame, custom_label) key — that would be
    //   ambiguous on lookup. Producers must disambiguate via custom_label.
    group_layout(stream_definition_frame const& frame, uint32_t group_id);

    // Convenience overload: resolves `group_name` via group_id_for and
    // delegates to the index-based ctor. Throws rkk::rgmp::v2::error if no
    // group with that name exists.
    group_layout(stream_definition_frame const& frame, std::string_view group_name);

    [[nodiscard]] uint32_t group_id() const noexcept { return group_id_; }

    // The group's name as declared in the source frame. Stored as a
    // string_view into the source frame's storage; the existing lifetime
    // contract (frame must outlive layout) makes that view safe.
    [[nodiscard]] std::string_view group_name() const noexcept
    {
        return group_name_;
    }

    // Captured from the source frame at construction. data_frame_writer reads
    // this when stamping the inner header so callers don't have to pass
    // frame.device_id alongside the index.
    [[nodiscard]] uint32_t device_id() const noexcept { return device_id_; }

    [[nodiscard]] size_t payload_size_bytes() const noexcept
    {
        return payload_size_bytes_;
    }

    [[nodiscard]] size_t stream_count() const noexcept
    {
        return entries_.size();
    }

    // Resolve a key to a stream slice over `payload`.
    // Throws rkk::rgmp::v2::error  if the key is unknown.
    // Throws rkk::rgmp::v2::error if `payload` is smaller than
    // payload_size_bytes().
    [[nodiscard]] data_frame_stream_view find(
        std::span<std::byte const>      payload,
        measure_type_t                  measure,
        std::string_view                target_frame,
        std::optional<std::string_view> reference_frame = std::nullopt,
        std::optional<std::string_view> custom_label    = std::nullopt
    ) const;

    [[nodiscard]] data_frame_stream_view_mut find_mut(
        std::span<std::byte>            payload,
        measure_type_t                  measure,
        std::string_view                target_frame,
        std::optional<std::string_view> reference_frame = std::nullopt,
        std::optional<std::string_view> custom_label    = std::nullopt
    ) const;

  private:
    friend class data_frame_writer;

    struct entry {
        size_t                 offset_bytes;
        base_data_entry const* def;
    };

    // Throws rkk::rgmp::v2::error with a contextual message.
    [[nodiscard]] size_t find_index_(
        measure_type_t                  measure,
        std::string_view                target_frame,
        std::optional<std::string_view> reference_frame,
        std::optional<std::string_view> custom_label
    ) const;

    uint32_t           device_id_;
    uint32_t           group_id_;
    std::string_view   group_name_;
    size_t             payload_size_bytes_;
    std::vector<entry> entries_; // transmission order
};

// Single-message writer. Owns one contiguous buffer sized for the whole wire
// message: 8 (outer header) + 16 (inner header) + payload_size_bytes(layout).
// The outer and inner headers are written up front; per-stream payload bytes
// are filled by `write<T>(...)`. `finish()` returns the wire-ready buffer and
// throws if any stream in the group was skipped.
//
// Lifetime: the supplied group_layout (and the underlying stream_definition_
// frame) must outlive the writer.
class data_frame_writer {
  public:
    // device_id is taken from layout.device_id() — it was captured when the
    // group_layout was built from its source frame.
    data_frame_writer(
        group_layout const& layout,
        uint64_t            timestamp_us
    );

    data_frame_writer(data_frame_writer const&)            = delete;
    data_frame_writer& operator=(data_frame_writer const&) = delete;
    data_frame_writer(data_frame_writer&&)                 = default;
    data_frame_writer& operator=(data_frame_writer&&)      = default;

    // Find the stream by key, then encode `values` into its slice.
    // Throws on unknown key (rkk::rgmp::v2::error), on base-type mismatch, or
    // on element-count mismatch (both rkk::rgmp::v2::error).
    template <typename T>
    void write(
        measure_type_t                  measure,
        std::string_view                target_frame,
        std::span<T const>              values,
        std::optional<std::string_view> reference_frame = std::nullopt,
        std::optional<std::string_view> custom_label    = std::nullopt
    );

    // Convenience for the common scalar CUSTOM case (battery_pct,
    // temperature, voltage, ...). Bakes in measure_type_t::custom and wraps
    // the single value in a one-element span so callers don't have to
    // hand-roll `std::span{&v, 1}`. custom_label is required because CUSTOM
    // streams are keyed by it.
    template <typename T>
    void write_custom_scalar(
        std::string_view                target_frame,
        std::string_view                custom_label,
        T                               value,
        std::optional<std::string_view> reference_frame = std::nullopt
    );

    // clang-format off
    // Sized typed convenience overloads, one per fixed-shape measure type.
    // The std::span<T const, N> parameter encodes the canonical wire shape, so
    // a wrong-sized array fails to compile. Each method forwards to write<T>;
    // the runtime type/count checks inside check_typed_stream_match still apply
    // and backstop a misconfigured stream.
    void write_position           (std::string_view target_frame, std::span<float const, 3> values, std::optional<std::string_view> reference_frame = std::nullopt);
    void write_angular_velocity   (std::string_view target_frame, std::span<float const, 3> values, std::optional<std::string_view> reference_frame = std::nullopt);
    void write_linear_velocity    (std::string_view target_frame, std::span<float const, 3> values, std::optional<std::string_view> reference_frame = std::nullopt);
    void write_linear_acceleration(std::string_view target_frame, std::span<float const, 3> values, std::optional<std::string_view> reference_frame = std::nullopt);
    void write_proper_acceleration(std::string_view target_frame, std::span<float const, 3> values, std::optional<std::string_view> reference_frame = std::nullopt);
    void write_magnetic_field     (std::string_view target_frame, std::span<float const, 3> values, std::optional<std::string_view> reference_frame = std::nullopt);
    void write_orientation        (std::string_view target_frame, std::span<float const, 4> values, std::optional<std::string_view> reference_frame = std::nullopt);
    void write_transform          (std::string_view target_frame, std::span<float const, 7> values, std::optional<std::string_view> reference_frame = std::nullopt);
    void write_status_flags       (std::string_view target_frame, uint32_t flags,                   std::optional<std::string_view> reference_frame = std::nullopt);
    // clang-format on

    // Returns wire-ready bytes (outer + inner + payload). Throws
    // rkk::rgmp::v2::error if any stream in the group was not written, since
    // silently shipping zeroed bytes is almost always a producer bug.
    [[nodiscard]] std::vector<std::byte> finish() &&;

  private:
    group_layout const*       layout_;
    std::vector<std::byte>    buffer_; // 8 (outer) + 16 (inner) +
                                       // payload_size_bytes
    // 0 = unwritten, 1 = written. Plain uint8_t (not vector<bool>) so
    // operator[] returns a real reference and the proxy-type wart stays out.
    std::vector<std::uint8_t> written_;
};

// Single-message reader. Mirrors data_frame_writer on the consumer side:
// constructed once per incoming data-frame body (the bytes after the 8-byte
// outer msg_header), it parses the 16-byte inner header up front and exposes
// per-measure read_* methods that combine group_layout lookup with the
// matching named decoder in one call.
//
// Lifetime: the supplied group_layout and the underlying body bytes must
// outlive the reader. The body is held as a non-owning span.
class data_frame_reader {
  public:
    // `body` must contain the data-frame inner header (16 bytes) followed by
    // the group's full stream payload. Typical use:
    //
    //     auto outer = read_msg_header(...8 bytes...);
    //     if (outer.prefix == msg_prefix::data) {
    //         data_frame_reader r(layout, body_span_of(outer.msg_len));
    //         auto pose = r.read_transform("pelvis");
    //         ...
    //     }
    //
    // Throws rkk::rgmp::v2::error if `body` is too small, or if the inner
    // header's group_id does not match `layout.group_id()`.
    data_frame_reader(group_layout const&        layout,
                      std::span<std::byte const> body);

    // Read the group_id from a data-frame body without constructing a reader.
    // Intended for the consumer's dispatch step: extract the group_id, look up
    // the matching group_layout, then pass that layout (plus the same body) to
    // the data_frame_reader ctor for the actual decode.
    //
    // Throws rkk::rgmp::v2::error if `body` has fewer than 16 bytes.
    [[nodiscard]] static uint32_t
    peek_group_id(std::span<std::byte const> body);

    [[nodiscard]] uint32_t device_id()    const noexcept { return header_.device_id; }
    [[nodiscard]] uint32_t group_id()     const noexcept { return header_.group_id; }
    [[nodiscard]] uint64_t timestamp_us() const noexcept { return header_.timestamp_us; }

    // Sized typed reads, one per fixed-shape measure. Each delegates to the
    // matching free read_* helper after resolving the stream slice through
    // the index. Throws on unknown key or measure-type mismatch.
    // clang-format off
    [[nodiscard]] std::array<float, 3> read_position           (std::string_view target_frame, std::optional<std::string_view> reference_frame = std::nullopt) const;
    [[nodiscard]] std::array<float, 3> read_angular_velocity   (std::string_view target_frame, std::optional<std::string_view> reference_frame = std::nullopt) const;
    [[nodiscard]] std::array<float, 3> read_linear_velocity    (std::string_view target_frame, std::optional<std::string_view> reference_frame = std::nullopt) const;
    [[nodiscard]] std::array<float, 3> read_linear_acceleration(std::string_view target_frame, std::optional<std::string_view> reference_frame = std::nullopt) const;
    [[nodiscard]] std::array<float, 3> read_proper_acceleration(std::string_view target_frame, std::optional<std::string_view> reference_frame = std::nullopt) const;
    [[nodiscard]] std::array<float, 3> read_magnetic_field     (std::string_view target_frame, std::optional<std::string_view> reference_frame = std::nullopt) const;
    [[nodiscard]] std::array<float, 4> read_orientation        (std::string_view target_frame, std::optional<std::string_view> reference_frame = std::nullopt) const;
    [[nodiscard]] std::array<float, 7> read_transform          (std::string_view target_frame, std::optional<std::string_view> reference_frame = std::nullopt) const;
    [[nodiscard]] uint32_t             read_status_flags       (std::string_view target_frame, std::optional<std::string_view> reference_frame = std::nullopt) const;
    // clang-format on

    // Resolve a status_flags stream's bit_mapping against the read uint32 and
    // return one (label, value) pair per declared bit, in ascending bit-
    // position order. Bits without a label in the producer's bit_mapping are
    // not in the result. Throws rkk::rgmp::v2::error if the stream has no
    // bit_mapping (use read_status_flags for raw uint32 access).
    [[nodiscard]] std::vector<std::pair<std::string, bool>>
    read_status_flags_named(
        std::string_view                target_frame,
        std::optional<std::string_view> reference_frame = std::nullopt
    ) const;

    // Generic escape hatch for CUSTOM streams or any future variable-shape
    // measure. Returns a fresh vector sized to the stream's element_count().
    template <typename T>
    [[nodiscard]] std::vector<T> read(
        measure_type_t                  measure,
        std::string_view                target_frame,
        std::optional<std::string_view> reference_frame = std::nullopt,
        std::optional<std::string_view> custom_label    = std::nullopt
    ) const;

    // Mirror of data_frame_writer::write_custom_scalar. Bakes in
    // measure_type_t::custom and unwraps the single-element result so
    // callers don't get a std::vector<T> they have to subscript. Throws
    // rkk::rgmp::v2::error if the resolved stream is not scalar (i.e. its
    // element count is not exactly 1) — use read<T> for vector/matrix
    // CUSTOM shapes.
    template <typename T>
    [[nodiscard]] T read_custom_scalar(
        std::string_view                target_frame,
        std::string_view                custom_label,
        std::optional<std::string_view> reference_frame = std::nullopt
    ) const;

  private:
    group_layout const*        layout_;
    data_frame_header          header_;
    std::span<std::byte const> payload_;
};

namespace detail {

// Validates `group_id` against `frame.groups` and `payload_size` against the
// group's expected payload size, then returns a reference to the group.
// Throws rkk::rgmp::v2::error  if group_id is out of bounds.
// Throws rkk::rgmp::v2::error if payload_size is smaller than expected.
[[nodiscard]] group const& validated_group_for_payload(
    stream_definition_frame const& frame,
    uint32_t                       group_id,
    size_t                         payload_size
);

template <typename T> constexpr base_data_type wire_base_for() noexcept
{
    if constexpr (std::is_same_v<T, int32_t>) {
        return base_data_type::int32;
    }
    else if constexpr (std::is_same_v<T, uint32_t>) {
        return base_data_type::uint32;
    }
    else if constexpr (std::is_same_v<T, int64_t>) {
        return base_data_type::int64;
    }
    else if constexpr (std::is_same_v<T, uint64_t>) {
        return base_data_type::uint64;
    }
    else if constexpr (std::is_same_v<T, float>) {
        return base_data_type::float32;
    }
    else {
        return base_data_type::double64;
    }
}

void check_typed_stream_match(
    parsed_data_type const& dt,
    base_data_type          requested_base,
    size_t                  caller_count,
    size_t                  view_bytes,
    char const*             op
);

} // namespace detail

// Walks the streams of `frame.groups[group_id]` and invokes `fn` for each one
// in transmission order. `fn` may be either of:
//   * (base_data_entry const&, std::span<std::byte[ const]>)
//   * (uint32_t index, base_data_entry const&, std::span<std::byte[ const]>)
// where `index` is the stream's 0-based position within the group. The 3-arg
// form is selected when both forms compile.
// Allocation-free; suitable for the hot path.
//
// Throws rkk::rgmp::v2::error  if group_id is out of bounds.
// Throws rkk::rgmp::v2::error if payload is smaller than the group's expected
// stream-payload size. Trailing bytes beyond that size are ignored.
template <typename Fn>
void for_each_stream(
    stream_definition_frame const& frame,
    uint32_t                       group_id,
    std::span<std::byte const>     payload,
    Fn&&                           fn
)
{
    auto const& g =
        detail::validated_group_for_payload(frame, group_id, payload.size());
    size_t offset = 0;
    for (uint32_t i = 0; i < g.streams.size(); ++i) {
        auto const&  s     = g.streams[i];
        size_t const n     = s.data_type.byte_size();
        auto         bytes = payload.subspan(offset, n);
        if constexpr (std::is_invocable_v<
                          Fn&,
                          uint32_t,
                          base_data_entry const&,
                          decltype(bytes)>) {
            fn(i, s, bytes);
        }
        else {
            fn(s, bytes);
        }
        offset += n;
    }
}

template <typename Fn>
void for_each_stream(
    stream_definition_frame const& frame,
    uint32_t                       group_id,
    std::span<std::byte>           payload,
    Fn&&                           fn
)
{
    auto const& g =
        detail::validated_group_for_payload(frame, group_id, payload.size());
    size_t offset = 0;
    for (uint32_t i = 0; i < g.streams.size(); ++i) {
        auto const&  s     = g.streams[i];
        size_t const n     = s.data_type.byte_size();
        auto         bytes = payload.subspan(offset, n);
        if constexpr (std::is_invocable_v<
                          Fn&,
                          uint32_t,
                          base_data_entry const&,
                          decltype(bytes)>) {
            fn(i, s, bytes);
        }
        else {
            fn(s, bytes);
        }
        offset += n;
    }
}

// Same lifetime contract as data_frame_stream_view: vector elements stay valid
// only as long as the source `frame` and `payload` outlive it.
[[nodiscard]] std::vector<data_frame_stream_view> data_frame_stream_views(
    stream_definition_frame const& frame,
    uint32_t                       group_id,
    std::span<std::byte const>     payload
);

[[nodiscard]] std::vector<data_frame_stream_view_mut> data_frame_stream_views(
    stream_definition_frame const& frame,
    uint32_t                       group_id,
    std::span<std::byte>           payload
);

// Decodes the entire stream described by `view` into `out`.
//
// Runtime checks:
//   * `T` must match the stream's base type (e.g. T=float requires FLOAT).
//   * `out.size()` must equal the stream's element_count().
// Both fail with rkk::rgmp::v2::error.
template <typename T>
void read_stream(data_frame_stream_view const& view, std::span<T> out)
{
    static_assert(
        detail::is_wire_codec_type_v<T>,
        "read_stream<T> only supports INT32 / UINT32 / INT64 / UINT64 / FLOAT "
        "/ DOUBLE"
    );
    detail::check_typed_stream_match(
        view.entry->data_type,
        detail::wire_base_for<T>(),
        out.size(),
        view.bytes.size(),
        "read_stream"
    );
    for (size_t i = 0; i < out.size(); ++i) {
        out[i] = read_le<T>(
            view.bytes.subspan(i * sizeof(T)).template first<sizeof(T)>()
        );
    }
}

// Allocating convenience overload that returns a fresh vector sized to the
// stream's element_count().
template <typename T>
[[nodiscard]] std::vector<T> read_stream(data_frame_stream_view const& view)
{
    std::vector<T> out(view.entry->data_type.element_count());
    read_stream<T>(view, std::span<T>(out));
    return out;
}

// Encodes `values` into the stream slice described by `view`. Runtime checks
// are symmetric to read_stream.
template <typename T>
void write_stream(data_frame_stream_view_mut const& view, std::span<T const> values)
{
    static_assert(
        detail::is_wire_codec_type_v<T>,
        "write_stream<T> only supports INT32 / UINT32 / INT64 / UINT64 / FLOAT "
        "/ DOUBLE"
    );
    detail::check_typed_stream_match(
        view.entry->data_type,
        detail::wire_base_for<T>(),
        values.size(),
        view.bytes.size(),
        "write_stream"
    );
    for (size_t i = 0; i < values.size(); ++i) {
        write_le<T>(
            values[i],
            view.bytes.subspan(i * sizeof(T)).template first<sizeof(T)>()
        );
    }
}

template <typename T>
void data_frame_writer::write(
    measure_type_t                  measure,
    std::string_view                target_frame,
    std::span<T const>              values,
    std::optional<std::string_view> reference_frame,
    std::optional<std::string_view> custom_label
)
{
    // The buffer layout is [8 outer header][16 inner header][payload].
    auto const payload_offset = size_t{8 + 16};
    auto payload_span = std::span<std::byte>(buffer_).subspan(payload_offset);

    auto const  i = layout_->find_index_(
        measure, target_frame, reference_frame, custom_label
    );
    auto const& e = layout_->entries_[i];
    data_frame_stream_view_mut view{
        e.def,
        payload_span.subspan(e.offset_bytes, e.def->data_type.byte_size())
    };
    write_stream<T>(view, values);
    written_[i] = 1u;
}

template <typename T>
void data_frame_writer::write_custom_scalar(
    std::string_view                target_frame,
    std::string_view                custom_label,
    T                               value,
    std::optional<std::string_view> reference_frame
)
{
    write<T>(
        measure_type_t::custom,
        target_frame,
        std::span<T const>{&value, 1},
        reference_frame,
        custom_label
    );
}

template <typename T>
std::vector<T> data_frame_reader::read(
    measure_type_t                  measure,
    std::string_view                target_frame,
    std::optional<std::string_view> reference_frame,
    std::optional<std::string_view> custom_label
) const
{
    auto view = layout_->find(
        payload_, measure, target_frame, reference_frame, custom_label
    );
    return read_stream<T>(view);
}

template <typename T>
T data_frame_reader::read_custom_scalar(
    std::string_view                target_frame,
    std::string_view                custom_label,
    std::optional<std::string_view> reference_frame
) const
{
    auto values = read<T>(
        measure_type_t::custom, target_frame, reference_frame, custom_label
    );
    if (values.size() not_eq 1) {
        throw error(
            "data_frame_reader::read_custom_scalar: CUSTOM stream (target='"
            + std::string{target_frame} + "', label='"
            + std::string{custom_label} + "') has "
            + std::to_string(values.size())
            + " elements, expected 1 (use read<T> for non-scalar shapes)"
        );
    }
    return values[0];
}

// clang-format off
// Sized typed convenience read functions, one per fixed-shape measure type.
// Each returns the canonical wire shape as a std::array, so the shape is fixed
// at compile time at the call site. Runtime checks: the view's measure_type
// must match the function's expected measure (throws rkk::rgmp::v2::error
// otherwise); the view's data_type and byte size are then checked via the
// existing read_stream<T> path.
[[nodiscard]] std::array<float, 3> read_position(data_frame_stream_view const& view);
[[nodiscard]] std::array<float, 3> read_angular_velocity(data_frame_stream_view const& view);
[[nodiscard]] std::array<float, 3> read_linear_velocity(data_frame_stream_view const& view);
[[nodiscard]] std::array<float, 3> read_linear_acceleration(data_frame_stream_view const& view);
[[nodiscard]] std::array<float, 3> read_proper_acceleration(data_frame_stream_view const& view);
[[nodiscard]] std::array<float, 3> read_magnetic_field(data_frame_stream_view const& view);
[[nodiscard]] std::array<float, 4> read_orientation(data_frame_stream_view const& view);
[[nodiscard]] std::array<float, 7> read_transform(data_frame_stream_view const& view);
[[nodiscard]] uint32_t             read_status_flags(data_frame_stream_view const& view);
// clang-format on

} // namespace rkk::rgmp::v2
