#pragma once

#include "rgmp_v2_stream_definition_frame.hpp"
#include "rgmp_v2_type_system.hpp"

#include <cstdint>
#include <optional>
#include <string>
#include <utility>

// Factory functions per measure_type_t. Each one bakes in the canonical wire
// shape so producers don't have to remember that POSITION is FLOAT[3] but
// ORIENTATION is FLOAT[4] and TRANSFORM is FLOAT[7]. Construction collapses
// from a five-line struct dance to a single function call.
namespace rkk::rgmp::v2::streams {

namespace detail {

inline parsed_data_type vec(uint32_t n)
{
    return {
        .base = base_data_type::float32,
        .rows = n,
        .cols = std::nullopt,
    };
}

inline base_data_entry vec_entry(
    measure_type_t             m,
    uint32_t                   n,
    std::string                target,
    std::optional<std::string> ref
)
{
    return base_data_entry{
        .data_type       = vec(n),
        .measure_type    = m,
        .target_frame    = std::move(target),
        .reference_frame = std::move(ref),
        .custom_label    = std::nullopt,
        .bit_mapping     = std::nullopt,
    };
}

} // namespace detail

// FLOAT[3] vector quantities.
inline base_data_entry
position(std::string target, std::optional<std::string> ref = {})
{
    return detail::vec_entry(
        measure_type_t::position,
        3,
        std::move(target),
        std::move(ref)
    );
}

inline base_data_entry
angular_velocity(std::string target, std::optional<std::string> ref = {})
{
    return detail::vec_entry(
        measure_type_t::angular_velocity,
        3,
        std::move(target),
        std::move(ref)
    );
}

inline base_data_entry
linear_velocity(std::string target, std::optional<std::string> ref = {})
{
    return detail::vec_entry(
        measure_type_t::linear_velocity,
        3,
        std::move(target),
        std::move(ref)
    );
}

inline base_data_entry
linear_acceleration(std::string target, std::optional<std::string> ref = {})
{
    return detail::vec_entry(
        measure_type_t::linear_acceleration,
        3,
        std::move(target),
        std::move(ref)
    );
}

inline base_data_entry
proper_acceleration(std::string target, std::optional<std::string> ref = {})
{
    return detail::vec_entry(
        measure_type_t::proper_acceleration,
        3,
        std::move(target),
        std::move(ref)
    );
}

inline base_data_entry
magnetic_field(std::string target, std::optional<std::string> ref = {})
{
    return detail::vec_entry(
        measure_type_t::magnetic_field,
        3,
        std::move(target),
        std::move(ref)
    );
}

// FLOAT[4] quaternion (x, y, z, w).
inline base_data_entry
orientation(std::string target, std::optional<std::string> ref = {})
{
    return detail::vec_entry(
        measure_type_t::orientation,
        4,
        std::move(target),
        std::move(ref)
    );
}

// FLOAT[7] = position(3) + orientation(4).
inline base_data_entry
transform(std::string target, std::optional<std::string> ref = {})
{
    return detail::vec_entry(
        measure_type_t::transform,
        7,
        std::move(target),
        std::move(ref)
    );
}

// UINT32 scalar with bit_mapping. validate_measure_data_type_pair enforces
// these constraints; the factory's signature makes them unviolatable at
// construction.
inline base_data_entry status_flags(std::string target, bit_mapping_t bits)
{
    return base_data_entry{
        .data_type       = {
            .base = base_data_type::uint32,
            .rows = std::nullopt,
            .cols = std::nullopt,
        },
        .measure_type    = measure_type_t::status_flags,
        .target_frame    = std::move(target),
        .reference_frame = std::nullopt,
        .custom_label    = std::nullopt,
        .bit_mapping     = std::move(bits),
    };
}

// CUSTOM with caller-chosen dtype. Defaults to FLOAT scalar — the most
// common case across the in-tree examples (e.g. battery_pct).
inline base_data_entry custom(
    std::string      target,
    std::string      label,
    parsed_data_type dtype = {
        .base = base_data_type::float32,
        .rows = std::nullopt,
        .cols = std::nullopt,
    }
)
{
    return base_data_entry{
        .data_type       = std::move(dtype),
        .measure_type    = measure_type_t::custom,
        .target_frame    = std::move(target),
        .reference_frame = std::nullopt,
        .custom_label    = std::move(label),
        .bit_mapping     = std::nullopt,
    };
}

} // namespace rkk::rgmp::v2::streams
