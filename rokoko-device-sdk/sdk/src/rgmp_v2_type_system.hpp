#pragma once

#include "rgmp_v2_basic_types.hpp"

#include <cstdint>
#include <map>
#include <optional>
#include <string>
#include <string_view>

#include <nlohmann/json.hpp>

namespace rkk::rgmp::v2 {

enum class base_data_type : uint8_t {
    int32,
    uint32,
    int64,
    uint64,
    float32,
    double64,
};

struct parsed_data_type {
    base_data_type          base{base_data_type::float32};
    std::optional<uint32_t> rows;
    std::optional<uint32_t> cols;

    [[nodiscard]] bool is_scalar() const { return not rows.has_value(); }

    [[nodiscard]] bool is_vector() const
    {
        return rows.has_value() and not cols.has_value();
    }

    [[nodiscard]] bool is_matrix() const { return cols.has_value(); }

    [[nodiscard]] size_t element_count() const;
    [[nodiscard]] size_t byte_size() const;
};

void to_json(nlohmann::json& j, parsed_data_type const& t);
void from_json(nlohmann::json const& j, parsed_data_type& t);

[[nodiscard]] std::string data_type_to_string(parsed_data_type const& t);

// Parses the canonical wire form: BASE | BASE[N] | BASE[N,M], where BASE is one
// of INT32 / UINT32 / INT64 / UINT64 / FLOAT / DOUBLE and N, M are decimal
// integers fitting in uint32_t. Throws rkk::rgmp::v2::error with message
// "Invalid data_type: '<input>'" on any syntactic failure. No shape validation
// is performed (e.g. zero dimensions parse fine here and are caught later by
// validate_data_type_shape).
[[nodiscard]] parsed_data_type parse_data_type(std::string_view s);

enum class measure_type_t : uint8_t {
    position,
    orientation,
    transform,
    angular_velocity,
    linear_velocity,
    linear_acceleration,
    proper_acceleration,
    magnetic_field,
    status_flags,
    custom,
};

// Strict JSON conversion: from_json throws rkk::rgmp::v2::error on unknown
// strings (the NLOHMANN_JSON_SERIALIZE_ENUM macro would silently fall back
// to the first entry, hiding typos like "POSITON" or out-of-spec values).
void to_json(nlohmann::json& j, measure_type_t const& m);
void from_json(nlohmann::json const& j, measure_type_t& m);

using bit_mapping_t = std::map<std::string, std::string>;

[[nodiscard]] size_t      base_data_type_size(base_data_type t);
[[nodiscard]] char const* base_data_type_to_string(base_data_type t);
[[nodiscard]] char const* measure_type_to_string(measure_type_t m);

// Verifies basic structural validity of a parsed_data_type. Currently this
// rejects zero-sized dimensions: per the protocol, the N and M in TYPE[N] /
// TYPE[N,M] must be >= 1. Throws rkk::rgmp::v2::error with `ctx` prefixed onto
// the message.
void validate_data_type_shape(
    parsed_data_type const& data_type,
    std::string const&      ctx = ""
);

void validate_measure_data_type_pair(
    measure_type_t          measure,
    parsed_data_type const& data_type,
    bool                    has_bit_mapping,
    bool                    has_custom_label
);

[[nodiscard]] uint32_t parse_bit_index(std::string_view s);

// Verifies that `value` is shape- and type-compatible with `data_type`:
//
//   * scalar types  -> JSON number of the matching base (integer types reject
//                       JSON floats; UINT32/UINT64 reject negatives; range is
//                       enforced for INT32/UINT32/INT64/UINT64)
//   * vectors [N]   -> JSON array of length N, each element a matching number
//   * matrices [N,M] -> flat JSON array of length N*M, row-major
//
// `null` is rejected. Throws rkk::rgmp::v2::error with `ctx` prefixed onto the
// message (e.g. ctx = "static_data[0].value").
void validate_value_against_data_type(
    parsed_data_type const& data_type,
    nlohmann::json const&   value,
    std::string const&      ctx = ""
);

} // namespace rkk::rgmp::v2
