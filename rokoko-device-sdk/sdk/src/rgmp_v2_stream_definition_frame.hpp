#pragma once

#include "rgmp_v2_basic_types.hpp"
#include "rgmp_v2_device_metadata.hpp"
#include "rgmp_v2_type_system.hpp"

#include <cstddef>
#include <cstdint>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

#include <nlohmann/json.hpp>

namespace rkk::rgmp::v2 {

// Strict JSON conversion: from_json throws on unknown strings rather than
// silently mapping them to the first entry. See the matching comment on
// measure_type_t for rationale.
void to_json(nlohmann::json& j, timestamp_epoch_t const& e);
void from_json(nlohmann::json const& j, timestamp_epoch_t& e);

struct base_data_entry {
    parsed_data_type             data_type;
    measure_type_t               measure_type{measure_type_t::custom};
    std::string                  target_frame;
    std::optional<std::string>   reference_frame;
    std::optional<std::string>   custom_label;
    std::optional<bit_mapping_t> bit_mapping;
};

// Hand-written rather than NLOHMANN_DEFINE_TYPE_NON_INTRUSIVE_WITH_DEFAULT
// so we don't claim a global adl_serializer<std::optional<T>> partial
// specialization slot, which would risk ODR conflicts with downstream
// projects that also serialize std::optional through nlohmann_json.
void to_json(nlohmann::json& j, base_data_entry const& t);
void from_json(nlohmann::json const& j, base_data_entry& t);

// Identity-and-type description for a static (constant) data point. Composes
// base_data_entry (rather than inheriting) so callers can use designated
// initialization across both halves: `{.base = streams::position(...), .value
// = ...}`. The JSON shape is still flat — to_json/from_json splice the base
// fields in next to `value`.
struct static_data_entry {
    base_data_entry base;
    nlohmann::json  value;
};

void to_json(nlohmann::json& j, static_data_entry const& t);
void from_json(nlohmann::json const& j, static_data_entry& t);

struct group {
    std::string                  name;
    double                       expected_rate_hz{0.0};
    std::vector<base_data_entry> streams;
};
NLOHMANN_DEFINE_TYPE_NON_INTRUSIVE_WITH_DEFAULT(
    group,
    name,
    expected_rate_hz,
    streams
)

struct stream_definition_frame {
    std::string       protocol_name{"RGMP"};
    std::string       protocol_version{"2.0.0"};
    uint32_t          device_id{0};
    std::string       device_type{};
    timestamp_epoch_t timestamp_epoch{timestamp_epoch_t::unix_epoch};
    device_metadata   device_info;
    std::vector<static_data_entry> static_data;
    std::vector<group>             groups;
};
NLOHMANN_DEFINE_TYPE_NON_INTRUSIVE_WITH_DEFAULT(
    stream_definition_frame,
    protocol_name,
    protocol_version,
    device_id,
    device_type,
    timestamp_epoch,
    device_info,
    static_data,
    groups
)

void validate(stream_definition_frame const& frame);
[[nodiscard]] stream_definition_frame
parse_stream_definition_frame(std::string_view json_string);

// Sugar overload for callers that have the JSON body as raw wire bytes
// (e.g. the consumer dispatcher peeling a stream_definition message off a
// TCP stream). Equivalent to the string_view overload — the bytes are
// reinterpreted as UTF-8 text. Throws rkk::rgmp::v2::error on invalid JSON
// or invalid frame, identical to the string_view overload.
[[nodiscard]] stream_definition_frame
parse_stream_definition_frame(std::span<std::byte const> json_bytes);

// Validates `f`, then JSON-encodes it. Symmetric to
// parse_stream_definition_frame: feeding the result back through the parse path
// reconstructs an equivalent frame. Throws rkk::rgmp::v2::error on invalid
// input with the same context-prefixed messages the parse path emits, so
// producers cannot ship malformed frames on the wire via this entry point.
[[nodiscard]] std::string
serialize_stream_definition_frame(stream_definition_frame const& f);

[[nodiscard]] size_t group_payload_size_bytes(group const& g);

// Resolve a group name to its positional index in `f.groups` — the index
// stamped into the inner data_frame_header and consumed by
// group_layout(frame, group_id). Throws rkk::rgmp::v2::error if no group
// matches. validate() rejects duplicate group names so this is always
// unambiguous on validated frames.
[[nodiscard]] uint32_t
group_id_for(stream_definition_frame const& f, std::string_view name);

[[nodiscard]] inline std::vector<std::byte>
frame_stream_definition(stream_definition_frame const& f)
{
    return frame_message(
        msg_prefix::stream_definition,
        serialize_stream_definition_frame(f)
    );
}

} // namespace rkk::rgmp::v2
