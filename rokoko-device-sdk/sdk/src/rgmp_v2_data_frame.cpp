#include "rgmp_v2_data_frame.hpp"

#include <algorithm>
#include <limits>
#include <stdexcept>
#include <string>
#include <utility>

namespace rkk::rgmp::v2 {

void write_data_frame_header(
    data_frame_header const& h,
    std::span<std::byte, 16> out
)
{
    write_u32_le(h.device_id, out.subspan<0, 4>());
    write_u32_le(h.group_id, out.subspan<4, 4>());
    write_u64_le(h.timestamp_us, out.subspan<8, 8>());
}

data_frame_header read_data_frame_header(std::span<std::byte const, 16> in)
{
    return data_frame_header{
        read_u32_le(in.subspan<0, 4>()),
        read_u32_le(in.subspan<4, 4>()),
        read_u64_le(in.subspan<8, 8>()),
    };
}

namespace {

// Bounds-check `gid` against `f.groups` and return a reference to the matching
// group. `ctx` is prefixed onto the error message so callers can identify which
// API surface threw.
[[nodiscard]] group const&
checked_group(stream_definition_frame const& f, uint32_t gid, char const* ctx)
{
    if (gid >= f.groups.size()) {
        throw error(
            std::string(ctx) + ": group_id " + std::to_string(gid)
            + " out of range (have " + std::to_string(f.groups.size())
            + " groups)"
        );
    }
    return f.groups[gid];
}

} // namespace

size_t group_payload_size_bytes(stream_definition_frame const& f, uint32_t gid)
{
    return group_payload_size_bytes(
        checked_group(f, gid, "group_payload_size_bytes")
    );
}

namespace detail {

group const& validated_group_for_payload(
    stream_definition_frame const& f,
    uint32_t                       gid,
    size_t                         payload_size
)
{
    auto const&  g        = checked_group(f, gid, "data_frame");
    size_t const expected = group_payload_size_bytes(g);
    if (payload_size < expected) {
        throw error(
            "data_frame: payload undersized (" + std::to_string(payload_size)
            + " bytes, need " + std::to_string(expected) + ")"
        );
    }
    return g;
}

void check_typed_stream_match(
    parsed_data_type const& dt,
    base_data_type          requested,
    size_t                  caller_count,
    size_t                  view_bytes,
    char const*             op
)
{
    if (dt.base not_eq requested) {
        throw error(
            std::string(op) + ": base type mismatch (stream is "
            + base_data_type_to_string(dt.base) + ", caller requested "
            + base_data_type_to_string(requested) + ")"
        );
    }
    size_t const expected = dt.element_count();
    if (caller_count not_eq expected) {
        throw error(
            std::string(op) + ": element count mismatch (stream has "
            + std::to_string(expected) + ", caller provided "
            + std::to_string(caller_count) + ")"
        );
    }
    size_t const expected_bytes = dt.byte_size();
    if (view_bytes < expected_bytes) {
        throw error(
            std::string(op) + ": view bytes too small ("
            + std::to_string(view_bytes) + " bytes, need "
            + std::to_string(expected_bytes) + ")"
        );
    }
}

} // namespace detail

std::vector<data_frame_stream_view> data_frame_stream_views(
    stream_definition_frame const& f,
    uint32_t                       gid,
    std::span<std::byte const>     payload
)
{
    std::vector<data_frame_stream_view> out;
    if (gid < f.groups.size()) {
        out.reserve(f.groups[gid].streams.size());
    }
    for_each_stream(
        f,
        gid,
        payload,
        [&](base_data_entry const& e, std::span<std::byte const> b) {
            out.push_back({&e, b});
        }
    );
    return out;
}

std::vector<data_frame_stream_view_mut> data_frame_stream_views(
    stream_definition_frame const& f,
    uint32_t                       gid,
    std::span<std::byte>           payload
)
{
    std::vector<data_frame_stream_view_mut> out;
    if (gid < f.groups.size()) {
        out.reserve(f.groups[gid].streams.size());
    }
    for_each_stream(
        f,
        gid,
        payload,
        [&](base_data_entry const& e, std::span<std::byte> b) {
            out.push_back({&e, b});
        }
    );
    return out;
}

namespace {

[[nodiscard]] bool optional_string_matches(
    std::optional<std::string> const&      lhs,
    std::optional<std::string_view> const& rhs
)
{
    if (lhs.has_value() not_eq rhs.has_value()) {
        return false;
    }
    if (lhs.has_value() and std::string_view(*lhs) not_eq *rhs) {
        return false;
    }
    return true;
}

// Reference-frame comparison treats nullopt and "explicitly == target_frame"
// as equivalent: both encode "intrinsic to target_frame". The wire format
// permits either form; lookup and uniqueness must consider them the same.
[[nodiscard]] bool reference_frame_matches(
    std::optional<std::string> const&      entry_ref,
    std::optional<std::string_view> const& query_ref,
    std::string_view                       target_frame
)
{
    auto entry_view = entry_ref.has_value()
        ? std::optional<std::string_view>{*entry_ref}
        : std::nullopt;

    auto canonicalize = [target_frame](std::optional<std::string_view> r) {
        if (r.has_value() and *r == target_frame) {
            return std::optional<std::string_view>{};
        }
        return r;
    };

    auto a = canonicalize(entry_view);
    auto b = canonicalize(query_ref);

    if (a.has_value() not_eq b.has_value()) {
        return false;
    }
    if (a.has_value() and *a not_eq *b) {
        return false;
    }
    return true;
}

[[nodiscard]] bool key_matches(
    base_data_entry const&          e,
    measure_type_t                  measure,
    std::string_view                target_frame,
    std::optional<std::string_view> reference_frame,
    std::optional<std::string_view> custom_label
)
{
    if (e.measure_type not_eq measure) {
        return false;
    }
    if (std::string_view(e.target_frame) not_eq target_frame) {
        return false;
    }
    if (not reference_frame_matches(
            e.reference_frame, reference_frame, target_frame
        )) {
        return false;
    }
    if (not optional_string_matches(e.custom_label, custom_label)) {
        return false;
    }
    return true;
}

[[nodiscard]] std::string format_key(
    measure_type_t                  measure,
    std::string_view                target_frame,
    std::optional<std::string_view> reference_frame,
    std::optional<std::string_view> custom_label
)
{
    std::string s = "(";
    s += measure_type_to_string(measure);
    s += ", '";
    s += std::string(target_frame);
    s += "'";
    if (reference_frame) {
        s += ", ref='";
        s += std::string(*reference_frame);
        s += "'";
    }
    if (custom_label) {
        s += ", label='";
        s += std::string(*custom_label);
        s += "'";
    }
    s += ")";
    return s;
}

[[nodiscard]] std::optional<std::string_view> as_view(
    std::optional<std::string> const& opt
)
{
    return opt.has_value()
        ? std::optional<std::string_view>(*opt)
        : std::nullopt;
}

} // namespace

group_layout::group_layout(
    stream_definition_frame const& frame,
    std::string_view               name
)
    : group_layout(frame, group_id_for(frame, name))
{}

group_layout::group_layout(stream_definition_frame const& frame, uint32_t gid)
    : device_id_(frame.device_id)
    , group_id_(gid)
    , payload_size_bytes_(0)
{
    auto const& g = checked_group(frame, gid, "group_layout");
    group_name_   = g.name;
    entries_.reserve(g.streams.size());

    size_t offset = 0;
    for (auto const& s : g.streams) {
        auto const ref   = as_view(s.reference_frame);
        auto const label = as_view(s.custom_label);

        for (auto const& existing : entries_) {
            if (key_matches(
                    *existing.def, s.measure_type, s.target_frame, ref, label
                )) {
                throw error(
                    "group_layout: duplicate key "
                    + format_key(s.measure_type, s.target_frame, ref, label)
                    + " in group " + std::to_string(gid)
                );
            }
        }
        entries_.push_back({offset, &s});
        offset += s.data_type.byte_size();
    }
    payload_size_bytes_ = offset;
}

size_t group_layout::find_index_(
    measure_type_t                  measure,
    std::string_view                target_frame,
    std::optional<std::string_view> reference_frame,
    std::optional<std::string_view> custom_label
) const
{
    for (size_t i = 0; i < entries_.size(); ++i) {
        if (key_matches(
                *entries_[i].def,
                measure,
                target_frame,
                reference_frame,
                custom_label
            )) {
            return i;
        }
    }
    throw error(
        "group_layout: no stream matching key "
        + format_key(measure, target_frame, reference_frame, custom_label)
        + " in group " + std::to_string(group_id_)
    );
}

namespace {

void check_payload_size(size_t payload_bytes, size_t need_bytes, char const* op)
{
    if (payload_bytes < need_bytes) {
        throw error(
            std::string(op) + ": payload undersized ("
            + std::to_string(payload_bytes) + " bytes, need "
            + std::to_string(need_bytes) + ")"
        );
    }
}

} // namespace

data_frame_stream_view group_layout::find(
    std::span<std::byte const>      payload,
    measure_type_t                  measure,
    std::string_view                target_frame,
    std::optional<std::string_view> reference_frame,
    std::optional<std::string_view> custom_label
) const
{
    check_payload_size(payload.size(), payload_size_bytes_, "group_layout::find");
    auto const  i = find_index_(measure, target_frame, reference_frame, custom_label);
    auto const& e = entries_[i];
    return data_frame_stream_view{
        e.def,
        payload.subspan(e.offset_bytes, e.def->data_type.byte_size())
    };
}

data_frame_stream_view_mut group_layout::find_mut(
    std::span<std::byte>            payload,
    measure_type_t                  measure,
    std::string_view                target_frame,
    std::optional<std::string_view> reference_frame,
    std::optional<std::string_view> custom_label
) const
{
    check_payload_size(
        payload.size(),
        payload_size_bytes_,
        "group_layout::find_mut"
    );
    auto const  i = find_index_(measure, target_frame, reference_frame, custom_label);
    auto const& e = entries_[i];
    return data_frame_stream_view_mut{
        e.def,
        payload.subspan(e.offset_bytes, e.def->data_type.byte_size())
    };
}

data_frame_writer::data_frame_writer(
    group_layout const& layout,
    uint64_t            timestamp_us
)
    : layout_(&layout)
    , buffer_(8 + 16 + layout.payload_size_bytes())
    , written_(layout.stream_count(), 0u)
{
    constexpr auto u32_max =
        static_cast<size_t>(std::numeric_limits<uint32_t>::max());
    auto const inner_len = 16 + layout.payload_size_bytes();
    if (inner_len > u32_max) {
        throw error(
            "data_frame_writer: message size " + std::to_string(inner_len)
            + " exceeds UINT32_MAX"
        );
    }

    auto wire = std::span<std::byte>(buffer_);
    write_msg_header(
        msg_header{msg_prefix::data, static_cast<uint32_t>(inner_len)},
        wire.first<8>()
    );
    write_data_frame_header(
        data_frame_header{layout.device_id(), layout.group_id(), timestamp_us},
        wire.subspan<8, 16>()
    );
}

std::vector<std::byte> data_frame_writer::finish() &&
{
    for (size_t i = 0; i < written_.size(); ++i) {
        if (not written_[i]) {
            auto const& e = layout_->entries_[i].def;
            throw error(
                "data_frame_writer::finish: stream " + std::to_string(i) + " ("
                + measure_type_to_string(e->measure_type) + ", '"
                + e->target_frame + "')" + " in group "
                + std::to_string(layout_->group_id()) + " was not written"
            );
        }
    }
    return std::move(buffer_);
}

uint32_t data_frame_reader::peek_group_id(std::span<std::byte const> body)
{
    constexpr size_t inner_header_size = 16;
    if (body.size() < inner_header_size) {
        throw error(
            "data_frame_reader::peek_group_id: body too small for inner "
            "header ("
            + std::to_string(body.size()) + " bytes, need at least "
            + std::to_string(inner_header_size) + ")"
        );
    }
    return read_data_frame_header(body.first<inner_header_size>()).group_id;
}

data_frame_reader::data_frame_reader(
    group_layout const&        layout,
    std::span<std::byte const> body
)
    : layout_(&layout)
    , header_{}
{
    constexpr size_t inner_header_size = 16;
    if (body.size() < inner_header_size) {
        throw error(
            "data_frame_reader: body too small for inner header ("
            + std::to_string(body.size()) + " bytes, need at least "
            + std::to_string(inner_header_size) + ")"
        );
    }
    header_ = read_data_frame_header(
        std::span<std::byte const, 16>(body.data(), inner_header_size)
    );

    if (header_.group_id not_eq layout.group_id()) {
        throw error(
            "data_frame_reader: group_id mismatch (inner header has "
            + std::to_string(header_.group_id)
            + ", group_layout built for group_id "
            + std::to_string(layout.group_id()) + ")"
        );
    }

    payload_ = body.subspan(inner_header_size);
    if (payload_.size() < layout.payload_size_bytes()) {
        throw error(
            "data_frame_reader: payload too small ("
            + std::to_string(payload_.size()) + " bytes, need "
            + std::to_string(layout.payload_size_bytes()) + ")"
        );
    }
}

std::array<float, 3> data_frame_reader::read_position(
    std::string_view target_frame, std::optional<std::string_view> reference_frame
) const
{
    return ::rkk::rgmp::v2::read_position(
        layout_->find(payload_, measure_type_t::position, target_frame, reference_frame)
    );
}

std::array<float, 3> data_frame_reader::read_angular_velocity(
    std::string_view target_frame, std::optional<std::string_view> reference_frame
) const
{
    return ::rkk::rgmp::v2::read_angular_velocity(
        layout_->find(payload_, measure_type_t::angular_velocity, target_frame, reference_frame)
    );
}

std::array<float, 3> data_frame_reader::read_linear_velocity(
    std::string_view target_frame, std::optional<std::string_view> reference_frame
) const
{
    return ::rkk::rgmp::v2::read_linear_velocity(
        layout_->find(payload_, measure_type_t::linear_velocity, target_frame, reference_frame)
    );
}

std::array<float, 3> data_frame_reader::read_linear_acceleration(
    std::string_view target_frame, std::optional<std::string_view> reference_frame
) const
{
    return ::rkk::rgmp::v2::read_linear_acceleration(
        layout_->find(payload_, measure_type_t::linear_acceleration, target_frame, reference_frame)
    );
}

std::array<float, 3> data_frame_reader::read_proper_acceleration(
    std::string_view target_frame, std::optional<std::string_view> reference_frame
) const
{
    return ::rkk::rgmp::v2::read_proper_acceleration(
        layout_->find(payload_, measure_type_t::proper_acceleration, target_frame, reference_frame)
    );
}

std::array<float, 3> data_frame_reader::read_magnetic_field(
    std::string_view target_frame, std::optional<std::string_view> reference_frame
) const
{
    return ::rkk::rgmp::v2::read_magnetic_field(
        layout_->find(payload_, measure_type_t::magnetic_field, target_frame, reference_frame)
    );
}

std::array<float, 4> data_frame_reader::read_orientation(
    std::string_view target_frame, std::optional<std::string_view> reference_frame
) const
{
    return ::rkk::rgmp::v2::read_orientation(
        layout_->find(payload_, measure_type_t::orientation, target_frame, reference_frame)
    );
}

std::array<float, 7> data_frame_reader::read_transform(
    std::string_view target_frame, std::optional<std::string_view> reference_frame
) const
{
    return ::rkk::rgmp::v2::read_transform(
        layout_->find(payload_, measure_type_t::transform, target_frame, reference_frame)
    );
}

uint32_t data_frame_reader::read_status_flags(
    std::string_view target_frame, std::optional<std::string_view> reference_frame
) const
{
    return ::rkk::rgmp::v2::read_status_flags(
        layout_->find(payload_, measure_type_t::status_flags, target_frame, reference_frame)
    );
}

std::vector<std::pair<std::string, bool>>
data_frame_reader::read_status_flags_named(
    std::string_view                target_frame,
    std::optional<std::string_view> reference_frame
) const
{
    auto view = layout_->find(
        payload_, measure_type_t::status_flags, target_frame, reference_frame
    );
    if (not view.entry->bit_mapping.has_value()) {
        throw error(
            "data_frame_reader::read_status_flags_named: status_flags stream "
            "(target='"
            + std::string{target_frame}
            + "') has no bit_mapping (use read_status_flags for raw uint32 access)"
        );
    }
    auto const  flags   = ::rkk::rgmp::v2::read_status_flags(view);
    auto const& mapping = *view.entry->bit_mapping;

    // bit_mapping_t is std::map<std::string, std::string> — keys are sorted
    // lexicographically ("0" < "1" < "10" < "2"), which is not bit-position
    // order. Parse into (bit, label) pairs and sort numerically before
    // building the result, so consumers always see ascending bit order.
    std::vector<std::pair<unsigned, std::string const*>> by_bit;
    by_bit.reserve(mapping.size());
    for (auto const& [bit_str, label] : mapping) {
        unsigned const bit = static_cast<unsigned>(std::stoul(bit_str));
        by_bit.emplace_back(bit, &label);
    }
    std::sort(by_bit.begin(), by_bit.end(),
              [](auto const& a, auto const& b) { return a.first < b.first; });

    std::vector<std::pair<std::string, bool>> result;
    result.reserve(by_bit.size());
    for (auto const& [bit, label_ptr] : by_bit) {
        bool const set = (flags & (uint32_t{1} << bit)) not_eq 0u;
        result.emplace_back(*label_ptr, set);
    }
    return result;
}

// ── Sized typed convenience overloads ────────────────────────────────────────

void data_frame_writer::write_position(
    std::string_view target, std::span<float const, 3> values,
    std::optional<std::string_view> reference_frame
)
{
    write<float>(measure_type_t::position, target, values, reference_frame);
}

void data_frame_writer::write_angular_velocity(
    std::string_view target, std::span<float const, 3> values,
    std::optional<std::string_view> reference_frame
)
{
    write<float>(measure_type_t::angular_velocity, target, values, reference_frame);
}

void data_frame_writer::write_linear_velocity(
    std::string_view target, std::span<float const, 3> values,
    std::optional<std::string_view> reference_frame
)
{
    write<float>(measure_type_t::linear_velocity, target, values, reference_frame);
}

void data_frame_writer::write_linear_acceleration(
    std::string_view target, std::span<float const, 3> values,
    std::optional<std::string_view> reference_frame
)
{
    write<float>(measure_type_t::linear_acceleration, target, values, reference_frame);
}

void data_frame_writer::write_proper_acceleration(
    std::string_view target, std::span<float const, 3> values,
    std::optional<std::string_view> reference_frame
)
{
    write<float>(measure_type_t::proper_acceleration, target, values, reference_frame);
}

void data_frame_writer::write_magnetic_field(
    std::string_view target, std::span<float const, 3> values,
    std::optional<std::string_view> reference_frame
)
{
    write<float>(measure_type_t::magnetic_field, target, values, reference_frame);
}

void data_frame_writer::write_orientation(
    std::string_view target, std::span<float const, 4> values,
    std::optional<std::string_view> reference_frame
)
{
    write<float>(measure_type_t::orientation, target, values, reference_frame);
}

void data_frame_writer::write_transform(
    std::string_view target, std::span<float const, 7> values,
    std::optional<std::string_view> reference_frame
)
{
    write<float>(measure_type_t::transform, target, values, reference_frame);
}

void data_frame_writer::write_status_flags(
    std::string_view target, uint32_t flags,
    std::optional<std::string_view> reference_frame
)
{
    write<uint32_t>(
        measure_type_t::status_flags,
        target,
        std::span<uint32_t const, 1>(&flags, 1),
        reference_frame
    );
}

namespace {

void check_measure(
    data_frame_stream_view const& view,
    measure_type_t                expected,
    char const*                   op
)
{
    if (view.entry->measure_type not_eq expected) {
        throw error(
            std::string(op) + ": measure_type mismatch (stream is "
            + measure_type_to_string(view.entry->measure_type)
            + ", caller requested " + measure_type_to_string(expected) + ")"
        );
    }
}

template <size_t N>
[[nodiscard]] std::array<float, N>
read_float_n(data_frame_stream_view const& view)
{
    std::array<float, N> out{};
    read_stream<float>(view, std::span<float>(out));
    return out;
}

} // namespace

std::array<float, 3> read_position(data_frame_stream_view const& view)
{
    check_measure(view, measure_type_t::position, "read_position");
    return read_float_n<3>(view);
}

std::array<float, 3> read_angular_velocity(data_frame_stream_view const& view)
{
    check_measure(view, measure_type_t::angular_velocity, "read_angular_velocity");
    return read_float_n<3>(view);
}

std::array<float, 3> read_linear_velocity(data_frame_stream_view const& view)
{
    check_measure(view, measure_type_t::linear_velocity, "read_linear_velocity");
    return read_float_n<3>(view);
}

std::array<float, 3> read_linear_acceleration(data_frame_stream_view const& view)
{
    check_measure(
        view,
        measure_type_t::linear_acceleration,
        "read_linear_acceleration"
    );
    return read_float_n<3>(view);
}

std::array<float, 3> read_proper_acceleration(data_frame_stream_view const& view)
{
    check_measure(
        view,
        measure_type_t::proper_acceleration,
        "read_proper_acceleration"
    );
    return read_float_n<3>(view);
}

std::array<float, 3> read_magnetic_field(data_frame_stream_view const& view)
{
    check_measure(view, measure_type_t::magnetic_field, "read_magnetic_field");
    return read_float_n<3>(view);
}

std::array<float, 4> read_orientation(data_frame_stream_view const& view)
{
    check_measure(view, measure_type_t::orientation, "read_orientation");
    return read_float_n<4>(view);
}

std::array<float, 7> read_transform(data_frame_stream_view const& view)
{
    check_measure(view, measure_type_t::transform, "read_transform");
    return read_float_n<7>(view);
}

uint32_t read_status_flags(data_frame_stream_view const& view)
{
    check_measure(view, measure_type_t::status_flags, "read_status_flags");
    std::array<uint32_t, 1> out{};
    read_stream<uint32_t>(view, std::span<uint32_t>(out));
    return out[0];
}

} // namespace rkk::rgmp::v2
