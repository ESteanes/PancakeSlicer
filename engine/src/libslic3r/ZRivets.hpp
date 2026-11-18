#pragma once

namespace Slic3r {

class LayerRegion;
class PrintObject;

// Plans the rivet grid on prepared fill surfaces: cuts the holes and records the sleeve/cap rings and the plugs.
void plan_z_rivets(PrintObject &object);
// Appends the sleeve and cap rings recorded by plan_z_rivets() to the region's fills.
void append_z_rivet_rings(LayerRegion &layerm);

} // namespace Slic3r
