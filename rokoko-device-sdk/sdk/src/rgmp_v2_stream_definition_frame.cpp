#include "rgmp_v2_stream_definition_frame.hpp"

#include <stdexcept>
#include <string>

namespace rkk::rgmp::v2 {

namespace {

struct timestamp_epoch_entry {
    timestamp_epoch_t id;
    char const*       name;
};

constexpr timestamp_epoch_entry timestamp_epoch_table[] = {
    { timestamp_epoch_t::unix_epoch,  "unix_epoch"},
    {timestamp_epoch_t::device_boot, "device_boot"},
};

char const* timestamp_epoch_to_string(timestamp_epoch_t e)
{
    for (auto const& entry : timestamp_epoch_table) {
        if (entry.id == e) {
            return entry.name;
        }
    }
    return "unknown";
}

void validate_data_entry_common(
    parsed_data_type const&             data_type,
    measure_type_t                      measure,
    std::optional<bit_mapping_t> const& bit_mapping,
    std::optional<std::string> const&   custom_label,
    std::string const&                  ctx
)
{
    validate_data_type_shape(data_type, ctx + ".data_type");
    try {
        validate_measure_data_type_pair(
            measure,
            data_type,
            bit_mapping.has_value(),
            custom_label.has_value()
        );
    }
    catch (std::exception const& ex) {
        throw error(ctx + ": " + ex.what());
    }
    if (bit_mapping) {
        for (auto const& [k, _] : *bit_mapping) {
            try {
                (void)parse_bit_index(k);
            }
            catch (std::exception const& ex) {
                throw error(ctx + ".bit_mapping: " + ex.what());
            }
        }
    }
}

[[nodiscard]] bool optional_strings_match(
    std::optional<std::string> const& a,
    std::optional<std::string> const& b
)
{
    if (a.has_value() not_eq b.has_value()) {
        return false;
    }
    if (a.has_value() and *a not_eq *b) {
        return false;
    }
    return true;
}

// A reference_frame explicitly equal to target_frame is semantically the same
// as omitting reference_frame ("intrinsic to target_frame"). Canonicalize to
// nullopt so the uniqueness check considers both forms equivalent.
[[nodiscard]] std::optional<std::string>
canonical_reference_frame(base_data_entry const& e)
{
    if (e.reference_frame.has_value()
        and *e.reference_frame == e.target_frame) {
        return std::nullopt;
    }
    return e.reference_frame;
}

[[nodiscard]] std::string format_uniqueness_key(base_data_entry const& e)
{
    std::string s = "(";
    s += measure_type_to_string(e.measure_type);
    s += ", '";
    s += e.target_frame;
    s += "'";
    auto const ref = canonical_reference_frame(e);
    if (ref) {
        s += ", ref='";
        s += *ref;
        s += "'";
    }
    if (e.custom_label) {
        s += ", label='";
        s += *e.custom_label;
        s += "'";
    }
    s += ")";
    return s;
}

void validate_group_stream_uniqueness(group const& g, std::string const& gctx)
{
    for (size_t i = 0; i < g.streams.size(); ++i) {
        for (size_t j = 0; j < i; ++j) {
            auto const& a = g.streams[i];
            auto const& b = g.streams[j];
            if (a.measure_type not_eq b.measure_type) {
                continue;
            }
            if (a.target_frame not_eq b.target_frame) {
                continue;
            }
            if (not optional_strings_match(
                    canonical_reference_frame(a),
                    canonical_reference_frame(b)
                )) {
                continue;
            }
            if (not optional_strings_match(a.custom_label, b.custom_label)) {
                continue;
            }
            throw error(
                gctx + ".streams[" + std::to_string(i)
                + "]: duplicate key " + format_uniqueness_key(a)
                + " (already declared at .streams[" + std::to_string(j) + "])"
            );
        }
    }
}

void check_required_fields(
    nlohmann::json const&              j,
    std::initializer_list<char const*> keys,
    std::string const&                 ctx
)
{
    for (auto const* k : keys) {
        if (not j.contains(k)) {
            throw error(ctx + ": missing required field '" + k + "'");
        }
    }
}

// JSON-presence-aware getter for std::optional fields. Treats both an absent
// key and an explicit null as nullopt. The to_json side mirrors this by
// emitting a key only when the optional has a value (no "field": null).
template <typename T>
std::optional<T> get_optional(nlohmann::json const& j, char const* key)
{
    if (not j.contains(key) or j.at(key).is_null()) {
        return std::nullopt;
    }
    return j.at(key).get<T>();
}

template <typename T>
void emit_optional(nlohmann::json& j, char const* key, std::optional<T> const& v)
{
    if (v.has_value()) {
        j[key] = *v;
    }
}

} // namespace

void to_json(nlohmann::json& j, base_data_entry const& t)
{
    j["data_type"]    = t.data_type;
    j["measure_type"] = t.measure_type;
    j["target_frame"] = t.target_frame;
    emit_optional(j, "reference_frame", t.reference_frame);
    emit_optional(j, "custom_label", t.custom_label);
    emit_optional(j, "bit_mapping", t.bit_mapping);
}

void from_json(nlohmann::json const& j, base_data_entry& t)
{
    base_data_entry const default_obj{};
    t.data_type       = j.value("data_type", default_obj.data_type);
    t.measure_type    = j.value("measure_type", default_obj.measure_type);
    t.target_frame    = j.value("target_frame", default_obj.target_frame);
    t.reference_frame = get_optional<std::string>(j, "reference_frame");
    t.custom_label    = get_optional<std::string>(j, "custom_label");
    t.bit_mapping     = get_optional<bit_mapping_t>(j, "bit_mapping");
}

void to_json(nlohmann::json& j, static_data_entry const& t)
{
    to_json(j, t.base);
    j["value"] = t.value;
}

void from_json(nlohmann::json const& j, static_data_entry& t)
{
    from_json(j, t.base);
    t.value = j.value("value", nlohmann::json{});
}

void to_json(nlohmann::json& j, timestamp_epoch_t const& e)
{
    j = timestamp_epoch_to_string(e);
}

void from_json(nlohmann::json const& j, timestamp_epoch_t& e)
{
    if (not j.is_string()) {
        throw error("timestamp_epoch must be a JSON string");
    }
    auto const s = j.get<std::string>();
    for (auto const& entry : timestamp_epoch_table) {
        if (s == entry.name) {
            e = entry.id;
            return;
        }
    }
    throw error("Unknown timestamp_epoch: '" + s + "'");
}

void validate(stream_definition_frame const& f)
{
    if (f.protocol_name not_eq "RGMP") {
        throw error(
            "protocol_name must be 'RGMP' (got '" + f.protocol_name + "')"
        );
    }
    if (f.protocol_version.empty()) {
        throw error("protocol_version must not be empty");
    }
    if (f.device_type.empty()) {
        throw error("device_type must not be empty");
    }
    if (f.groups.empty()) {
        throw error("groups: must contain at least one group");
    }
    for (size_t gi = 0; gi < f.groups.size(); ++gi) {
        auto const& g    = f.groups[gi];
        std::string gctx = "groups[" + std::to_string(gi) + "]";
        for (size_t gj = 0; gj < gi; ++gj) {
            if (f.groups[gj].name == g.name) {
                throw error(
                    gctx + ".name: duplicate group name '" + g.name + "'"
                );
            }
        }
        if (g.expected_rate_hz < 0.0) {
            throw error(gctx + ".expected_rate_hz must be >= 0");
        }
        if (g.streams.empty()) {
            throw error(gctx + ".streams: must contain at least one stream");
        }
        for (size_t si = 0; si < g.streams.size(); ++si) {
            auto const& e    = g.streams[si];
            std::string ectx = gctx + ".streams[" + std::to_string(si) + "]";
            validate_data_entry_common(
                e.data_type,
                e.measure_type,
                e.bit_mapping,
                e.custom_label,
                ectx
            );
        }
        validate_group_stream_uniqueness(g, gctx);
    }
    for (size_t i = 0; i < f.static_data.size(); ++i) {
        auto const& s    = f.static_data[i];
        std::string sctx = "static_data[" + std::to_string(i) + "]";
        validate_data_entry_common(
            s.base.data_type,
            s.base.measure_type,
            s.base.bit_mapping,
            s.base.custom_label,
            sctx
        );
        validate_value_against_data_type(
            s.base.data_type,
            s.value,
            sctx + ".value"
        );
    }
}

std::string serialize_stream_definition_frame(stream_definition_frame const& f)
{
    validate(f);
    return nlohmann::json(f).dump();
}

stream_definition_frame
parse_stream_definition_frame(std::span<std::byte const> json_bytes)
{
    return parse_stream_definition_frame(std::string_view{
        reinterpret_cast<char const*>(json_bytes.data()),
        json_bytes.size()
    });
}

stream_definition_frame
parse_stream_definition_frame(std::string_view json_string)
{
    nlohmann::json j;
    try {
        j = nlohmann::json::parse(json_string);
    }
    catch (nlohmann::json::parse_error const& ex) {
        throw error(std::string("JSON parse error: ") + ex.what());
    }
    check_required_fields(
        j,
        {"protocol_name",
         "protocol_version",
         "device_id",
         "device_type",
         "timestamp_epoch",
         "groups"},
        "stream_definition_frame"
    );

    auto const& groups_j = j.at("groups");
    if (not groups_j.is_array()) {
        throw error("groups: must be an array");
    }
    for (size_t gi = 0; gi < groups_j.size(); ++gi) {
        std::string const gctx = "groups[" + std::to_string(gi) + "]";
        check_required_fields(
            groups_j[gi],
            {"name", "expected_rate_hz", "streams"},
            gctx
        );
        auto const& streams_j = groups_j[gi].at("streams");
        if (not streams_j.is_array()) {
            throw error(gctx + ".streams: must be an array");
        }
        for (size_t si = 0; si < streams_j.size(); ++si) {
            std::string const ectx =
                gctx + ".streams[" + std::to_string(si) + "]";
            check_required_fields(
                streams_j[si],
                {"data_type", "measure_type", "target_frame"},
                ectx
            );
        }
    }
    if (j.contains("static_data")) {
        auto const& sd_j = j.at("static_data");
        if (not sd_j.is_array()) {
            throw error("static_data: must be an array");
        }
        for (size_t i = 0; i < sd_j.size(); ++i) {
            std::string const sctx = "static_data[" + std::to_string(i) + "]";
            check_required_fields(
                sd_j[i],
                {"data_type", "measure_type", "target_frame", "value"},
                sctx
            );
        }
    }

    stream_definition_frame frame;
    try {
        frame = j.get<stream_definition_frame>();
    }
    catch (nlohmann::json::exception const& ex) {
        throw error(std::string("JSON deserialization error: ") + ex.what());
    }
    validate(frame);
    return frame;
}

size_t group_payload_size_bytes(group const& g)
{
    size_t total = 0;
    for (auto const& s : g.streams) {
        total += s.data_type.byte_size();
    }
    return total;
}

uint32_t group_id_for(stream_definition_frame const& f, std::string_view name)
{
    for (size_t i = 0; i < f.groups.size(); ++i) {
        if (f.groups[i].name == name) {
            return static_cast<uint32_t>(i);
        }
    }
    throw error(
        "group_id_for: no group named '" + std::string{name} + "'"
    );
}

} // namespace rkk::rgmp::v2
