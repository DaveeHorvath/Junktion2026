#include "rgmp_v2_device_disconnect_frame.hpp"

#include <array>
#include <string>

namespace rkk::rgmp::v2 {

void write_device_disconnect_frame(
    device_disconnect_frame const& f,
    std::span<std::byte, 4>        out
)
{
    write_u32_le(f.device_id, out);
}

device_disconnect_frame
read_device_disconnect_frame(std::span<std::byte const, 4> in)
{
    return device_disconnect_frame{read_u32_le(in)};
}

device_disconnect_frame
parse_device_disconnect_frame(std::span<std::byte const> body)
{
    constexpr size_t expected_size = 4;
    if (body.size() < expected_size) {
        throw error(
            "parse_device_disconnect_frame: body too small ("
            + std::to_string(body.size()) + " bytes, need at least "
            + std::to_string(expected_size) + ")"
        );
    }
    return read_device_disconnect_frame(body.first<expected_size>());
}

std::vector<std::byte>
frame_device_disconnect(device_disconnect_frame const& f)
{
    std::array<std::byte, 4> body{};
    write_device_disconnect_frame(f, body);
    return frame_message(msg_prefix::device_disconnect, body);
}

} // namespace rkk::rgmp::v2
