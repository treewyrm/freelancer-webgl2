/** Things written once per capture rather than once per draw: texture identity, the picture. */
#pragma once

#include <d3d8.h>

namespace capture {

/** One `texture` line: description and a content hash per mip level. Must be on its own line. */
void writeTexture(IDirect3DBaseTexture8* texture);

/** One `shot` line and a BMP beside the log: the front buffer, after that frame's `Present`. */
void writeShot(IDirect3DDevice8* device, unsigned frame);

}  // namespace capture
