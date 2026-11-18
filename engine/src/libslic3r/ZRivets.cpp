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
        for (LayerRegion *layerm : layer->regions())
            layerm->z_rivet_sites.clear();
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

        // Floor under a span: 0 none, 1 solid infill, 2 sparse infill, so print a cap disk.
        auto floor_state = [&](size_t l, const Point &p) {
            if (areas[l].sparse.contains(p))
                return 2;
            return areas[l].any.contains(p) && !areas[l].near.contains(p) ? 1 : 0;
        };

        std::vector<std::vector<LayerRegion::ZRivetSite>> sites(layers.size());
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
                // Spans at one site are stacked end to end, each plug the floor of the next, so the site is one
                // continuous pillar. Neighbouring sites get different phases, so the plug ends are staggered like brickwork.
                const int phase    = ((i + 3 * j) % span + span) % span;
                bool      on_plug  = false;
                for (int c = phase; c + span + 1 < nlay; c += span) {
                    const int floor = on_plug ? 1 : floor_state(c, p);
                    bool      open  = floor != 0 && areas[c + span + 1].any.contains(p);
                    for (int l = c + 1; open && l <= c + span; ++l)
                        open = areas[l].hole.contains(p);
                    on_plug = open;
                    if (!open)
                        continue;
                    if (floor == 2)
                        sites[c].push_back({ p, true, true, 0.f, 0.f });
                    for (int l = c + 1; l < c + span; ++l)
                        sites[l].push_back({ p, areas[l].near.contains(p), false, 0.f, 0.f });
                    const double depth = layers[c + span]->print_z - layers[c]->print_z;
                    sites[c + span].push_back({ p, areas[c + span].near.contains(p), false, float(M_PI * r * r * depth * plug_overfill),
                                                float(depth) });
                }
            }

        // A sleeve ring lines the hole where sparse infill surrounds it; solid infill bounds the hole by itself.
        const coord_t cut_sleeve = coord_t(scale_(r + 0.9 * w));
        const coord_t cut_bare   = coord_t(scale_(r));
        tbb::parallel_for(tbb::blocked_range<size_t>(0, layers.size()), [&](const tbb::blocked_range<size_t> &range) {
            for (size_t l = range.begin(); l < range.end(); ++l) {
                if (sites[l].empty())
                    continue;
                LayerRegion *layerm = layers[l]->get_region(int(region_id));
                Polygons     disks;
                disks.reserve(sites[l].size());
                for (const LayerRegion::ZRivetSite &site : sites[l]) {
                    disks.emplace_back(make_circle_num_segments(double(site.sleeve ? cut_sleeve : cut_bare), 24));
                    disks.back().translate(site.center);
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
                layerm->z_rivet_sites          = std::move(sites[l]);
            }
        });
    }
}

void append_z_rivet_rings(LayerRegion &layerm)
{
    if (layerm.z_rivet_sites.empty())
        return;
    const Flow   flow   = layerm.flow(frInfill);
    const double nozzle = flow.nozzle_diameter();
    const double r      = region_hole_radius(layerm.region().config(), nozzle);
    const double w      = flow.width();
    const float  h      = float(layerm.layer()->height);
    auto ring = [&](ExtrusionEntityCollection &coll, const Point &center, double radius, double width, size_t segments) {
        Polygon circle = make_circle_num_segments(scale_(radius), segments);
        circle.translate(center);
        auto *path     = new ExtrusionPath(erInternalInfill, Flow(float(width), h, float(nozzle)).mm3_per_mm(), float(width), h);
        path->polyline = Polyline3(circle.split_at_first_point());
        coll.entities.push_back(path);
    };
    for (const LayerRegion::ZRivetSite &site : layerm.z_rivet_sites) {
        auto *coll    = new ExtrusionEntityCollection();
        coll->no_sort = true;
        if (site.sleeve)
            ring(*coll, site.center, r + 0.5 * w, w, 24);
        if (site.cap)
            ring(*coll, site.center, 0.5 * r, std::max(r, 0.5 * w), 8);
        if (site.plug_volume > 0.f) {
            const double len  = r;
            auto        *plug = new ZRivetPlugPath(erInternalInfill, site.plug_volume / len, float(2. * r), site.plug_depth);
            plug->polyline    = Polyline3(Polyline(site.center - Point::new_scale(0.5 * len, 0.), site.center + Point::new_scale(0.5 * len, 0.)));
            coll->entities.push_back(plug);
        }
        layerm.fills.entities.push_back(coll);
    }
}

} // namespace Slic3r
