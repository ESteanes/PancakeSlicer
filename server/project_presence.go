package main

import (
	"encoding/json"
	"net/http"
	"sort"
)

type projectViewer struct {
	session string
	label   string
	since   int64
}

type projectViewerInfo struct {
	Label string `json:"label"`
	Since int64  `json:"since"`
	Mine  bool   `json:"mine"`
}

type openProjectInfo struct {
	Project json.RawMessage     `json:"project"`
	Viewers []projectViewerInfo `json:"viewers"`
}

func (st *workspaceStore) addProjectViewer(id string, viewer *projectViewer) {
	if st.projectViewers == nil {
		st.projectViewers = make(map[string]map[*projectViewer]struct{})
	}
	if st.projectViewers[id] == nil {
		st.projectViewers[id] = make(map[*projectViewer]struct{})
	}
	st.projectViewers[id][viewer] = struct{}{}
}

func (st *workspaceStore) removeProjectViewer(id string, viewer *projectViewer) {
	st.mu.Lock()
	defer st.mu.Unlock()
	delete(st.projectViewers[id], viewer)
	if len(st.projectViewers[id]) == 0 {
		delete(st.projectViewers, id)
	}
}

func (st *workspaceStore) openProjects(w http.ResponseWriter, r *http.Request) {
	st.locked(w, func(d *workspaceData) {
		ids := make([]string, 0, len(st.projectViewers))
		for id := range st.projectViewers {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		projects := make([]openProjectInfo, 0, len(ids))
		for _, id := range ids {
			p, ok := d.Projects[id]
			if !ok || p.Archived || p.Record == nil {
				continue
			}
			sessions := make(map[string]*projectViewer)
			for viewer := range st.projectViewers[id] {
				if old := sessions[viewer.session]; old == nil || viewer.since < old.since {
					sessions[viewer.session] = viewer
				}
			}
			if len(sessions) == 0 {
				continue
			}
			viewers := make([]*projectViewer, 0, len(sessions))
			for _, viewer := range sessions {
				viewers = append(viewers, viewer)
			}
			sort.Slice(viewers, func(i, j int) bool {
				if viewers[i].since == viewers[j].since {
					return viewers[i].session < viewers[j].session
				}
				return viewers[i].since < viewers[j].since
			})
			row := openProjectInfo{Project: st.cachedProjectMeta(id, p), Viewers: make([]projectViewerInfo, 0, len(viewers))}
			for _, viewer := range viewers {
				row.Viewers = append(row.Viewers, projectViewerInfo{Label: viewer.label, Since: viewer.since, Mine: viewer.session == r.Header.Get(sessionHeader)})
			}
			projects = append(projects, row)
		}
		writeJSON(w, http.StatusOK, projects)
	})
}
