#pragma once

#include "ExtrusionEntity.hpp"

namespace Slic3r {

class LayerRegion;
class PrintObject;

// The plug that fills a rivet hole from its top layer: a short line over the hole centre whose cross-section carries the
// whole hole volume. width is the hole diameter and height the hole depth.
class ZRivetPlugPath : public ExtrusionPath
{
public:
    using ExtrusionPath::ExtrusionPath;
    ExtrusionEntity *clone() const override { return new ZRivetPlugPath(*this); }
    ExtrusionEntity *clone_move() override { return new ZRivetPlugPath(std::move(*this)); }
    bool             can_reverse() const override { return false; }
};

// Plans the rivet grid on prepared fill surfaces: cuts the holes and records the sleeve, cap and plug of every site.
void plan_z_rivets(PrintObject &object);
// Appends one fill collection per rivet site recorded by plan_z_rivets(): the sleeve, the cap, then the plug.
void append_z_rivet_rings(LayerRegion &layerm);

} // namespace Slic3r
