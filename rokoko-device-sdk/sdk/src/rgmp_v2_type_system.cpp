#include "rgmp_v2_type_system.hpp"

#include <charconv>
#include <limits>
#include <stdexcept>
#include <string>
#include <string_view>
#include <system_error>

namespace rkk::rgmp::v2 {

namespace {

struct base_data_type_entry {
    base_data_type id;
    char const*    name;
};

constexpr base_data_type_entry base_data_type_table[] = {
    {   base_data_type::int32,  "INT32"},
    {  base_data_type::uint32, "UINT32"},
    {   base_data_type::int64,  "INT64"},
    {  base_data_type::uint64, "UINT64"},
    { base_data_type::float32,  "FLOAT"},
    {base_data_type::double64, "DOUBLE"},
};

bool consume_prefix(std::string_view& s, std::string_view prefix)
{
    if (not s.starts_with(prefix)) {
        return false;
    }
    s.remove_prefix(prefix.size());
    return true;
}

std::optional<base_data_type> consume_base_data_type(std::string_view& s)
{
    for (auto const& e : base_data_type_table) {
        if (consume_prefix(s, e.name)) {
            return e.id;
        }
    }
    return std::nullopt;
}

// Parses one or more decimal digits from the front of `s` into `out`.
// Fails on no leading digit or on overflow of uint32_t.
bool consume_uint32(std::string_view& s, uint32_t& out)
{
    if (s.empty() or s.front() < '0' or s.front() > '9') {
        return false;
    }
    constexpr uint64_t max32 = std::numeric_limits<uint32_t>::max();
    uint64_t           v     = 0;
    size_t             i     = 0;
    while (i < s.size() and s[i] >= '0' and s[i] <= '9') {
        v = v * 10 + static_cast<uint64_t>(s[i] - '0');
        if (v > max32) {
            return false;
        }
        ++i;
    }
    s.remove_prefix(i);
    out = static_cast<uint32_t>(v);
    return true;
}

std::string error_prefix(std::string const& ctx)
{
    return ctx.empty() ? std::string{} : ctx + ": ";
}

} // namespace

char const* base_data_type_to_string(base_data_type t)
{
    for (auto const& e : base_data_type_table) {
        if (e.id == t) {
            return e.name;
        }
    }
    return "UNKNOWN";
}

size_t parsed_data_type::element_count() const
{
    if (not rows) {
        return 1;
    }
    return cols ? static_cast<size_t>(*rows) * static_cast<size_t>(*cols)
                : static_cast<size_t>(*rows);
}

size_t parsed_data_type::byte_size() const
{
    return element_count() * base_data_type_size(base);
}

size_t base_data_type_size(base_data_type t)
{
    switch (t) {
    case base_data_type::int32:
    case base_data_type::uint32:
    case base_data_type::float32: return 4;
    case base_data_type::int64:
    case base_data_type::uint64:
    case base_data_type::double64: return 8;
    }
    return 0;
}

std::string data_type_to_string(parsed_data_type const& t)
{
    std::string s = base_data_type_to_string(t.base);
    if (t.rows) {
        if (t.cols) {
            s += "[" + std::to_string(*t.rows) + "," + std::to_string(*t.cols)
               + "]";
        }
        else {
            s += "[" + std::to_string(*t.rows) + "]";
        }
    }
    return s;
}

parsed_data_type parse_data_type(std::string_view s)
{
    auto const       original = s;
    parsed_data_type out;

    auto invalid = [&] {
        return error("Invalid data_type: '" + std::string(original) + "'");
    };

    auto base = consume_base_data_type(s);
    if (not base) {
        throw invalid();
    }
    out.base = *base;

    if (not s.empty()) {
        if (not consume_prefix(s, "[")) {
            throw invalid();
        }
        uint32_t rows = 0;
        if (not consume_uint32(s, rows)) {
            throw invalid();
        }
        out.rows = rows;
        if (consume_prefix(s, ",")) {
            uint32_t cols = 0;
            if (not consume_uint32(s, cols)) {
                throw invalid();
            }
            out.cols = cols;
        }
        if (not consume_prefix(s, "]")) {
            throw invalid();
        }
    }
    if (not s.empty()) {
        throw invalid();
    }

    return out;
}

void to_json(nlohmann::json& j, parsed_data_type const& t)
{
    j = data_type_to_string(t);
}

void from_json(nlohmann::json const& j, parsed_data_type& t)
{
    if (not j.is_string()) {
        throw error("data_type must be a JSON string");
    }
    std::string      s      = j.get<std::string>();
    parsed_data_type parsed = parse_data_type(s);
    validate_data_type_shape(parsed, "data_type '" + s + "'");
    t = parsed;
}

void validate_data_type_shape(parsed_data_type const& dt, std::string const& ctx)
{
    std::string const prefix = error_prefix(ctx);
    auto check_zero = [&](char const* dim, std::optional<uint32_t> const& v) {
        if (v.has_value() and *v == 0) {
            throw error(
                prefix + dim + " dimension must be >= 1 (got "
                + data_type_to_string(dt) + ")"
            );
        }
    };
    check_zero("row", dt.rows);
    check_zero("column", dt.cols);
    if (dt.cols.has_value() and not dt.rows.has_value()) {
        throw error(
            prefix + "column dimension is set but row dimension is not (got "
            + data_type_to_string(dt) + ")"
        );
    }
}

namespace {

struct measure_type_entry {
    measure_type_t id;
    char const*    name;
};

constexpr measure_type_entry measure_type_table[] = {
    {           measure_type_t::position,            "POSITION"},
    {        measure_type_t::orientation,         "ORIENTATION"},
    {          measure_type_t::transform,           "TRANSFORM"},
    {   measure_type_t::angular_velocity,    "ANGULAR_VELOCITY"},
    {    measure_type_t::linear_velocity,     "LINEAR_VELOCITY"},
    {measure_type_t::linear_acceleration, "LINEAR_ACCELERATION"},
    {measure_type_t::proper_acceleration, "PROPER_ACCELERATION"},
    {     measure_type_t::magnetic_field,      "MAGNETIC_FIELD"},
    {       measure_type_t::status_flags,        "STATUS_FLAGS"},
    {             measure_type_t::custom,              "CUSTOM"},
};

} // namespace

char const* measure_type_to_string(measure_type_t m)
{
    for (auto const& e : measure_type_table) {
        if (e.id == m) {
            return e.name;
        }
    }
    return "UNKNOWN";
}

void to_json(nlohmann::json& j, measure_type_t const& m)
{
    j = measure_type_to_string(m);
}

void from_json(nlohmann::json const& j, measure_type_t& m)
{
    if (not j.is_string()) {
        throw error("measure_type must be a JSON string");
    }
    auto const s = j.get<std::string>();
    for (auto const& e : measure_type_table) {
        if (s == e.name) {
            m = e.id;
            return;
        }
    }
    throw error("Unknown measure_type: '" + s + "'");
}

void validate_measure_data_type_pair(
    measure_type_t          measure,
    parsed_data_type const& data_type,
    bool                    has_bit_mapping,
    bool                    has_custom_label
)
{
    if (measure == measure_type_t::status_flags) {
        if (data_type.base not_eq base_data_type::uint32
            or not data_type.is_scalar()) {
            throw error("STATUS_FLAGS requires scalar UINT32 data_type");
        }
        if (not has_bit_mapping) {
            throw error("STATUS_FLAGS requires bit_mapping to be present");
        }
    }
    if (measure == measure_type_t::custom and not has_custom_label) {
        throw error("CUSTOM measure_type requires custom_label");
    }
    if (measure not_eq measure_type_t::custom and has_custom_label) {
        throw error(
            "custom_label is only allowed when measure_type == CUSTOM"
        );
    }
}

namespace {

bool fits_int32(nlohmann::json const& j)
{
    if (j.is_number_unsigned()) {
        return j.get<uint64_t>()
            <= static_cast<uint64_t>(std::numeric_limits<int32_t>::max());
    }
    if (j.is_number_integer()) {
        auto const s = j.get<int64_t>();
        return s >= std::numeric_limits<int32_t>::min()
           and s <= std::numeric_limits<int32_t>::max();
    }
    return false;
}

bool fits_uint32(nlohmann::json const& j)
{
    if (j.is_number_unsigned()) {
        return j.get<uint64_t>() <= std::numeric_limits<uint32_t>::max();
    }
    if (j.is_number_integer()) {
        auto const s = j.get<int64_t>();
        return s >= 0
           and static_cast<uint64_t>(s) <= std::numeric_limits<uint32_t>::max();
    }
    return false;
}

bool fits_int64(nlohmann::json const& j)
{
    if (j.is_number_unsigned()) {
        return j.get<uint64_t>()
            <= static_cast<uint64_t>(std::numeric_limits<int64_t>::max());
    }
    return j.is_number_integer();
}

bool fits_uint64(nlohmann::json const& j)
{
    if (j.is_number_unsigned()) {
        return true;
    }
    if (j.is_number_integer()) {
        return j.get<int64_t>() >= 0;
    }
    return false;
}

void validate_scalar_value(
    parsed_data_type const& dt,
    nlohmann::json const&   v,
    std::string const&      ctx
)
{
    auto const  prefix     = error_prefix(ctx);
    char const* base_label = base_data_type_to_string(dt.base);

    if (not v.is_number()) {
        throw error(
            prefix + "expected " + base_label + " number, got "
            + std::string(v.type_name())
        );
    }
    bool const wants_integer = dt.base == base_data_type::int32
                            or dt.base == base_data_type::uint32
                            or dt.base == base_data_type::int64
                            or dt.base == base_data_type::uint64;
    if (wants_integer and v.is_number_float()) {
        throw error(
            prefix + "expected " + base_label + " integer, got float " + v.dump()
        );
    }

    bool ok = true;
    switch (dt.base) {
    case base_data_type::int32: ok = fits_int32(v); break;
    case base_data_type::uint32: ok = fits_uint32(v); break;
    case base_data_type::int64: ok = fits_int64(v); break;
    case base_data_type::uint64: ok = fits_uint64(v); break;
    case base_data_type::float32:
    case base_data_type::double64: ok = true; break;
    }
    if (not ok) {
        throw error(
            prefix + "value " + v.dump() + " out of range for " + base_label
        );
    }
}

} // namespace

void validate_value_against_data_type(
    parsed_data_type const& dt,
    nlohmann::json const&   v,
    std::string const&      ctx
)
{
    if (v.is_null()) {
        throw error(error_prefix(ctx) + "must not be null");
    }

    if (dt.is_scalar()) {
        validate_scalar_value(dt, v, ctx);
        return;
    }

    auto const expected_n = dt.element_count();
    auto const dt_label   = data_type_to_string(dt);
    if (not v.is_array()) {
        throw error(
            error_prefix(ctx) + "expected " + dt_label + " (flat array of "
            + std::to_string(expected_n) + " numbers), got "
            + std::string(v.type_name())
        );
    }
    if (v.size() not_eq expected_n) {
        throw error(
            error_prefix(ctx) + "expected " + dt_label + " (flat array of "
            + std::to_string(expected_n) + " numbers), got array of size "
            + std::to_string(v.size())
        );
    }
    for (size_t i = 0; i < v.size(); ++i) {
        validate_scalar_value(dt, v[i], ctx + "[" + std::to_string(i) + "]");
    }
}

uint32_t parse_bit_index(std::string_view s)
{
    if (s.empty()) {
        throw error("Bit index is empty");
    }
    // STATUS_FLAGS is always scalar UINT32 (enforced in
    // validate_measure_data_type_pair), so any bit index >= 32 is meaningless.
    uint32_t v              = 0;
    auto const [ptr, ec]    = std::from_chars(s.data(), s.data() + s.size(), v);
    bool const consumed_all = (ptr == s.data() + s.size());
    if (ec == std::errc{} and consumed_all and v < 32) {
        return v;
    }
    if (ec == std::errc::invalid_argument or not consumed_all) {
        throw error(
            "Bit index must be a non-negative decimal: '" + std::string(s) + "'"
        );
    }
    throw error(
        "Bit index out of range for UINT32 STATUS_FLAGS (must be < 32): '"
        + std::string(s) + "'"
    );
}

} // namespace rkk::rgmp::v2
