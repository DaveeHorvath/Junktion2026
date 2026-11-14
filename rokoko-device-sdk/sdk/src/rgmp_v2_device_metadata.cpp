#include "rgmp_v2_device_metadata.hpp"

#include <stdexcept>
#include <string>

namespace rkk::rgmp::v2 {

void to_json(nlohmann::json& j, device_metadata_value const& v)
{
    std::visit([&](auto const& x) { j = x; }, v.as_variant());
}

void from_json(nlohmann::json const& j, device_metadata_value& v)
{
    if (j.is_string()) {
        v = j.get<std::string>();
    }
    else if (j.is_boolean()) {
        v = j.get<bool>();
    }
    else if (j.is_number_integer() or j.is_number_unsigned()) {
        v = j.get<int64_t>();
    }
    else if (j.is_number_float()) {
        v = j.get<double>();
    }
    else {
        throw error(
            "device_info: only scalar values (string/bool/int/double) are "
            "supported, got "
            + std::string(j.type_name())
        );
    }
}

void to_json(nlohmann::json& j, device_metadata const& m)
{
    j = nlohmann::json::object();
    for (auto const& [k, v] : m) {
        j[k] = v;
    }
}

void from_json(nlohmann::json const& j, device_metadata& m)
{
    if (not j.is_object()) {
        throw error("device_info: must be a JSON object");
    }
    m.clear();
    for (auto const& [k, v] : j.items()) {
        m.emplace(k, v.get<device_metadata_value>());
    }
}

} // namespace rkk::rgmp::v2
