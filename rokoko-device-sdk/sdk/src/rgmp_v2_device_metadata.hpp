#pragma once

#include "rgmp_v2_basic_types.hpp"

#include <concepts>
#include <cstdint>
#include <map>
#include <string>
#include <variant>

#include <nlohmann/json.hpp>

namespace rkk::rgmp::v2 {

// Typed scalar value for the device_info object in the Stream Definition Frame.
// The wire schema permits arbitrary JSON inside device_info, but in practice
// every shipped value across the in-tree examples is a flat scalar
// (string/bool/integer/number). Modelling that explicitly keeps the public
// header free of nlohmann_json and lets producers use designated-init without
// learning a JSON construction API.
class device_metadata_value {
  public:
    using storage = std::variant<std::string, bool, int64_t, double>;

    // Defaults to an empty string — there is no "no value" state for a
    // variant, and an empty string is the least-surprising default for a
    // textual metadata field. Required so nlohmann_json's `from_json` path
    // can default-construct before assigning.
    device_metadata_value() = default;

    device_metadata_value(char const* s)
        : v_(std::string{s})
    {
    }

    device_metadata_value(std::string s)
        : v_(std::move(s))
    {
    }

    device_metadata_value(bool b)
        : v_(b)
    {
    }

    // Any integer kind (uint8_t..int64_t, signed or unsigned) funnels to
    // int64_t so producers can write `{"k", 42}` or `{"k", uint32_t{x}}`
    // without ambiguity against the bool / double overloads. bool is excluded
    // so `false` still selects the bool overload.
    template <std::integral T>
    requires(not std::same_as<T, bool>)
    device_metadata_value(T i)
        : v_(static_cast<int64_t>(i))
    {
    }

    template <std::floating_point T>
    device_metadata_value(T d)
        : v_(static_cast<double>(d))
    {
    }

    [[nodiscard]] storage const& as_variant() const noexcept { return v_; }

    [[nodiscard]] bool is_string() const noexcept
    {
        return std::holds_alternative<std::string>(v_);
    }

    [[nodiscard]] bool is_bool() const noexcept
    {
        return std::holds_alternative<bool>(v_);
    }

    [[nodiscard]] bool is_int() const noexcept
    {
        return std::holds_alternative<int64_t>(v_);
    }

    [[nodiscard]] bool is_double() const noexcept
    {
        return std::holds_alternative<double>(v_);
    }

    [[nodiscard]] std::string const& as_string() const
    {
        return std::get<std::string>(v_);
    }

    [[nodiscard]] bool as_bool() const { return std::get<bool>(v_); }

    [[nodiscard]] int64_t as_int() const { return std::get<int64_t>(v_); }

    [[nodiscard]] double as_double() const { return std::get<double>(v_); }

    bool operator==(device_metadata_value const&) const = default;

  private:
    storage v_;
};

using device_metadata = std::map<std::string, device_metadata_value>;

void to_json(nlohmann::json& j, device_metadata_value const& v);
void from_json(nlohmann::json const& j, device_metadata_value& v);

void to_json(nlohmann::json& j, device_metadata const& m);
void from_json(nlohmann::json const& j, device_metadata& m);

} // namespace rkk::rgmp::v2
