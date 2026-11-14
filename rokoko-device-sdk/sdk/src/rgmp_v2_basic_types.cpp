#include "rgmp_v2_basic_types.hpp"

#include <algorithm>
#include <stdexcept>
#include <string>

namespace rkk::rgmp::v2 {

char const* msg_prefix_to_string(msg_prefix p)
{
    switch (p) {
    case msg_prefix::stream_definition: return "stream_definition";
    case msg_prefix::data: return "data";
    case msg_prefix::device_disconnect: return "device_disconnect";
    }
    return "unknown";
}

namespace {

bool is_known_msg_prefix(uint32_t raw)
{
    switch (raw) {
    case static_cast<uint32_t>(msg_prefix::stream_definition):
    case static_cast<uint32_t>(msg_prefix::data):
    case static_cast<uint32_t>(msg_prefix::device_disconnect): return true;
    default: return false;
    }
}

} // namespace

void write_u32_le(uint32_t v, std::span<std::byte, 4> out) noexcept
{
    out[0] = std::byte(v & 0xffu);
    out[1] = std::byte((v >> 8) & 0xffu);
    out[2] = std::byte((v >> 16) & 0xffu);
    out[3] = std::byte((v >> 24) & 0xffu);
}

void write_u64_le(uint64_t v, std::span<std::byte, 8> out) noexcept
{
    out[0] = std::byte(v & 0xffu);
    out[1] = std::byte((v >> 8) & 0xffu);
    out[2] = std::byte((v >> 16) & 0xffu);
    out[3] = std::byte((v >> 24) & 0xffu);
    out[4] = std::byte((v >> 32) & 0xffu);
    out[5] = std::byte((v >> 40) & 0xffu);
    out[6] = std::byte((v >> 48) & 0xffu);
    out[7] = std::byte((v >> 56) & 0xffu);
}

uint32_t read_u32_le(std::span<std::byte const, 4> in) noexcept
{
    return static_cast<uint32_t>(in[0]) | (static_cast<uint32_t>(in[1]) << 8)
         | (static_cast<uint32_t>(in[2]) << 16)
         | (static_cast<uint32_t>(in[3]) << 24);
}

uint64_t read_u64_le(std::span<std::byte const, 8> in) noexcept
{
    return static_cast<uint64_t>(in[0]) | (static_cast<uint64_t>(in[1]) << 8)
         | (static_cast<uint64_t>(in[2]) << 16)
         | (static_cast<uint64_t>(in[3]) << 24)
         | (static_cast<uint64_t>(in[4]) << 32)
         | (static_cast<uint64_t>(in[5]) << 40)
         | (static_cast<uint64_t>(in[6]) << 48)
         | (static_cast<uint64_t>(in[7]) << 56);
}

void write_msg_header(msg_header const& h, std::span<std::byte, 8> out)
{
    write_u32_le(static_cast<uint32_t>(h.prefix), out.subspan<0, 4>());
    write_u32_le(h.msg_len, out.subspan<4, 4>());
}

msg_header read_msg_header(std::span<std::byte const, 8> in)
{
    uint32_t raw = read_u32_le(in.subspan<0, 4>());
    if (not is_known_msg_prefix(raw)) {
        throw error("read_msg_header: unknown msg_prefix " + std::to_string(raw));
    }
    return msg_header{
        static_cast<msg_prefix>(raw),
        read_u32_le(in.subspan<4, 4>())
    };
}

std::vector<std::byte>
frame_message(msg_prefix prefix, std::span<std::byte const> payload)
{
    constexpr auto max_len =
        static_cast<size_t>(std::numeric_limits<uint32_t>::max());
    if (payload.size() > max_len) {
        throw error(
            "frame_message: payload size " + std::to_string(payload.size())
            + " exceeds UINT32_MAX"
        );
    }
    std::vector<std::byte> out(8 + payload.size());
    write_msg_header(
        msg_header{prefix, static_cast<uint32_t>(payload.size())},
        std::span<std::byte>(out).first<8>()
    );
    std::copy(payload.begin(), payload.end(), out.begin() + 8);
    return out;
}

std::vector<std::byte> frame_message(msg_prefix prefix, std::string_view payload)
{
    return frame_message(
        prefix,
        std::span<std::byte const>(
            reinterpret_cast<std::byte const*>(payload.data()),
            payload.size()
        )
    );
}

} // namespace rkk::rgmp::v2
