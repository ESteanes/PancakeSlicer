#include "ZRivets.hpp"

#include "BoundingBox.hpp"
#include "ClipperUtils.hpp"
#include "ExPolygon.hpp"
#include "ExtrusionEntity.hpp"
#include "ExtrusionEntityCollection.hpp"
#include "Flow.hpp"
#include "Layer.hpp"
#include "Point.hpp"
#include "Polygon.hpp"
#include "Print.hpp"
#include "PrintConfig.hpp"
#include "Surface.hpp"
#include "SurfaceCollection.hpp"

#include <tbb/blocked_range.h>
#include <tbb/parallel_for.h>

#include <algorithm>
#include <cmath>
#include <utility>
#include <vector>

namespace Slic3r {

namespace {

constexpr double plug_overfill = 1.10;

struct Area
{
    ExPolygons               expolygons;
    std::vector<BoundingBox> boxes;

    explicit Area(ExPolygons &&src = {}) : expolygons(std::move(src))
    {
        boxes.reserve(expolygons.size());
        for (const ExPolygon &e : expolygons)
            boxes.emplace_back(get_extents(e.contour));
    }
    bool contains(const Point &p) const
    {
        for (size_t i = 0; i < expolygons.size(); ++i)
            if (boxes[i].contains(p) && expolygons[i].contains(p))
                return true;
        return false;
    }
};

// Disk-clearance tests for one layer: hole = disk fits in sparse or internal solid infill, sparse = disk fits in sparse
// infill, near = disk touches sparse infill, any = disk fits in any fill surface.
struct LayerAreas
{
    Area hole, sparse, near, any;
};

double region_hole_radius(const PrintRegionConfig &cfg, double nozzle) { return 0.5 * cfg.z_rivet_diameter.get_abs_value(nozzle); }

} // namespace

void plan_z_rivets(PrintObject &object)
{
    LayerPtrs &layers = object.layers();
    for (Layer *layer : layers)
        for (LayerRegion *layerm : layer->regions()) {
            layerm->z_rivet_rings.clear();
            layerm->z_rivet_plugs.clear();
        }
    if (layers.size() < 4)
        return;

    for (size_t region_id = 0; region_id < object.num_printing_regions(); ++region_id) {
        const PrintRegion       &region = object.printing_region(region_id);
        const PrintRegionConfig &cfg    = region.config();
        if (!cfg.z_rivets.value)
            continue;
        const double nozzle = object.print()->config().nozzle_diameter.get_at(std::max(1u, region.extruder(frInfill)) - 1);
        const double r      = region_hole_radius(cfg, nozzle);
        const double w      = layers[1]->get_region(int(region_id))->flow(frInfill).width();
        if (!(r > 0.) || !(w > 0.))
            continue;
        const int    span  = std::max(2, cfg.z_rivet_span.value);
        const int    cycle = span + 1;
        const double pitch = std::max(1., cfg.z_rivet_spacing.value);
        const float  clear = float(scale_(r + w));

        std::vector<LayerAreas> areas(layers.size());
        tbb::parallel_for(tbb::blocked_range<size_t>(0, layers.size()), [&](const tbb::blocked_range<size_t> &range) {
            for (size_t l = range.begin(); l < range.end(); ++l) {
                const SurfaceCollection &fs     = layers[l]->get_region(int(region_id))->fill_surfaces;
                const Polygons           sparse = to_polygons(fs.filter_by_type(stInternal));
                areas[l].hole   = Area(offset_ex(to_polygons(fs.filter_by_types({ stInternal, stInternalSolid })), -clear));
                areas[l].sparse = Area(offset_ex(sparse, -clear));
                areas[l].near   = Area(offset_ex(sparse, clear));
                areas[l].any    = Area(offset_ex(to_polygons(fs.surfaces), -clear));
            }
        });

        // 0: the disk can not cap a span here, 1: solid infill caps it, 2: sparse infill, so print a cap ring.
        auto cap_state = [&](size_t l, const Point &p) {
            if (areas[l].sparse.contains(p))
                return 2;
            return areas[l].any.contains(p) && !areas[l].near.contains(p) ? 1 : 0;
        };

        std::vector<std::vector<LayerRegion::ZRivetRing>> rings(layers.size());
        std::vector<std::vector<LayerRegion::ZRivetPlug>> plugs(layers.size());
        const BoundingBox bb   = object.bounding_box();
        const Point       mid  = bb.center();
        const double      dy   = pitch * std::sqrt(3.) / 2.;
        const int         ni   = int(std::ceil(unscale<double>(bb.size().x()) / (2. * pitch))) + 1;
        const int         nj   = int(std::ceil(unscale<double>(bb.size().y()) / (2. * dy))) + 1;
        const int         nlay = int(layers.size());
        for (int j = -nj; j <= nj; ++j)
            for (int i = -ni; i <= ni; ++i) {
                const Point p = mid + Point::new_scale((i + 0.5 * (j & 1)) * pitch, j * dy);
                if (!bb.contains(p))
                    continue;
                // Neighbouring sites get different phases, so the plug ends are staggered like brickwork.
                const int phase    = ((i + 3 * j) % cycle + cycle) % cycle;
                int       last_cap = -1;
                for (int c = phase; c + cycle < nlay; c += cycle) {
                    const int below = cap_state(c, p);
                    const int above = below ? cap_state(c + cycle, p) : 0;
                    if (!above)
                        continue;
                    bool open = true;
                    for (int l = c + 1; open && l <= c + span; ++l)
                        open = areas[l].hole.contains(p);
                    if (!open)
                        continue;
                    if (below == 2 && last_cap != c)
                        rings[c].push_back({ p, erInternalInfill, true });
                    if (above == 2)
                        rings[c + cycle].push_back({ p, erInternalInfill, true });
                    last_cap = c + cycle;
                    for (int l = c + 1; l <= c + span; ++l)
                        rings[l].push_back({ p, areas[l].sparse.contains(p) ? erInternalInfill : erSolidInfill, false });
                    const double depth = layers[c + span]->print_z - layers[c]->print_z;
                    plugs[c + span].push_back({ p, float(M_PI * r * r * depth * plug_overfill), float(depth), float(2. * r) });
                }
            }

        const coord_t cut = coord_t(scale_(r + 0.9 * w));
        tbb::parallel_for(tbb::blocked_range<size_t>(0, layers.size()), [&](const tbb::blocked_range<size_t> &range) {
            for (size_t l = range.begin(); l < range.end(); ++l) {
                if (rings[l].empty())
                    continue;
                LayerRegion *layerm = layers[l]->get_region(int(region_id));
                Polygons     disks;
                disks.reserve(rings[l].size());
                for (const LayerRegion::ZRivetRing &ring : rings[l]) {
                    disks.emplace_back(make_circle_num_segments(double(cut), 24));
                    disks.back().translate(ring.center);
                }
                Surfaces out;
                out.reserve(layerm->fill_surfaces.surfaces.size());
                for (const Surface &s : layerm->fill_surfaces.surfaces) {
                    if (s.surface_type != stInternal && s.surface_type != stInternalSolid) {
                        out.push_back(s);
                        continue;
                    }
                    for (ExPolygon &piece : diff_ex(s.expolygon, disks))
                        out.emplace_back(s, std::move(piece));
                }
                layerm->fill_surfaces.surfaces = std::move(out);
                layerm->z_rivet_rings          = std::move(rings[l]);
                layerm->z_rivet_plugs          = std::move(plugs[l]);
            }
        });
    }
}

void append_z_rivet_rings(LayerRegion &layerm)
{
    if (layerm.z_rivet_rings.empty())
        return;
    const Flow   flow   = layerm.flow(frInfill);
    const double nozzle = flow.nozzle_diameter();
    const double r      = region_hole_radius(layerm.region().config(), nozzle);
    const double w      = flow.width();
    const float  h      = float(layerm.layer()->height);
    auto        *coll   = new ExtrusionEntityCollection();
    auto add = [&](const LayerRegion::ZRivetRing &ring, double radius, double width, size_t segments) {
        Polygon circle = make_circle_num_segments(scale_(radius), segments);
        circle.translate(ring.center);
        auto *path     = new ExtrusionPath(ring.role, Flow(float(width), h, float(nozzle)).mm3_per_mm(), float(width), h);
        path->polyline = Polyline3(circle.split_at_first_point());
        coll->entities.push_back(path);
    };
    for (const LayerRegion::ZRivetRing &ring : layerm.z_rivet_rings) {
        add(ring, r + 0.5 * w, w, 24);
        if (ring.cap)
            add(ring, 0.5 * r, std::max(r, 0.5 * w), 8);
    }
    layerm.fills.entities.push_back(coll);
}

} // namespace Slic3r
