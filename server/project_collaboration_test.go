package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func sharedWorkspace(t *testing.T) (*workspaceStore, *http.ServeMux) {
	t.Helper()
	st, d := &workspaceStore{root: t.TempDir()}, newWorkspaceData()
	d.Projects["project"] = workspaceProject{Collaborative: true, Revision: 1, Record: json.RawMessage(`{
		"meta":{"id":"project","name":"Original","objects":0,"savedAt":1,"revision":1},
		"doc":{"projectName":"Original","plateIndex":1,"objects":[],"events":[],"files":{},
		"projectPlates":[{"index":1,"objects":[],"events":[]},{"index":2,"objects":[],"events":[]}]}
	}`)}
	if err := st.save(d); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	st.register(mux)
	return st, mux
}

func sharedRequest(t *testing.T, mux *http.ServeMux, method, path, body, tokens string, want int) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set(sessionHeader, "test-session")
	r.Header.Set("X-Orca-Edit-Locks", tokens)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	if w.Code != want {
		t.Fatalf("%s %s: %d, want %d: %s", method, path, w.Code, want, w.Body)
	}
	return w
}

func TestPresenceCachesMetadataButRefreshesViewers(t *testing.T) {
	st, mux := sharedWorkspace(t)
	viewer := &projectViewer{session: "test-session", label: "Browser", since: 1}
	st.addProjectViewer("project", viewer)
	read := func() []openProjectInfo {
		w := sharedRequest(t, mux, "GET", "/api/projects/open", "", "", 200)
		var rows []openProjectInfo
		if err := json.Unmarshal(w.Body.Bytes(), &rows); err != nil {
			t.Fatal(err)
		}
		if w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("presence must not be cached by clients")
		}
		return rows
	}
	if rows := read(); len(rows) != 1 || len(rows[0].Viewers) != 1 || !rows[0].Viewers[0].Mine {
		t.Fatalf("unexpected presence: %+v", rows)
	}
	first := st.views["project-meta:project"].(json.RawMessage)
	st.addProjectViewer("project", &projectViewer{session: "another-session", since: 2})
	if rows := read(); len(rows) != 1 || len(rows[0].Viewers) != 2 || &first[0] != &st.views["project-meta:project"].(json.RawMessage)[0] {
		t.Fatal("viewer updates should reuse project metadata")
	}
	d, err := st.read()
	if err != nil {
		t.Fatal(err)
	}
	p := d.Projects["project"]
	p.Record = bytes.ReplaceAll(p.Record, []byte("Original"), []byte("Renamed"))
	d.Projects["project"] = p
	if err := st.save(d); err != nil {
		t.Fatal(err)
	}
	if rows := read(); len(rows) != 1 || !bytes.Contains(rows[0].Project, []byte(`"name":"Renamed"`)) {
		t.Fatal("metadata stayed stale after saving")
	}
}

func TestSharedRenameRequiresSettingsLock(t *testing.T) {
	st, mux := sharedWorkspace(t)
	body := `{"operationId":"rename","expectedRevision":1,"name":"Renamed"}`
	sharedRequest(t, mux, "POST", "/api/projects/project/rename", body, "", 409)
	w := sharedRequest(t, mux, "POST", "/api/projects/project/locks", `{"action":"acquire","keys":["settings"]}`, "", 200)
	var status struct {
		Locks map[string]editLock `json:"locks"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	tokens := string(jsonValue(map[string]string{"settings": status.Locks["settings"].Token}))
	sharedRequest(t, mux, "POST", "/api/projects/project/rename", body, tokens, 200)
	d, err := st.read()
	if err != nil {
		t.Fatal(err)
	}
	var record sharedRecord
	if err := json.Unmarshal(d.Projects["project"].Record, &record); err != nil {
		t.Fatal(err)
	}
	if record.Meta["name"] != "Renamed" || record.Doc["projectName"] != "Renamed" || d.Projects["project"].Revision != 2 {
		t.Fatal("rename did not update both the saved name and document")
	}
}

func TestKeptSlicePreservesPinnedPlate(t *testing.T) {
	st, mux := sharedWorkspace(t)
	j := &Job{ID: "slice", Dir: t.TempDir(), state: StateDone, slice: json.RawMessage(`{}`),
		Request: JobRequest{Output: "gcode", ProjectSnapshot: &projectSnapshotRef{ID: "project", Revision: 1, Version: 1, PlateIndex: 2}}}
	s := &Server{workspace: st, jobs: &JobManager{cfg: Config{JobRoot: t.TempDir()}, jobs: map[string]*Job{j.ID: j}}}
	s.versionRoutes(mux)
	sharedRequest(t, mux, "POST", "/api/versions/project/seal", `{"revision":1}`, "", 200)
	sharedRequest(t, mux, "POST", "/api/versions/project/1/slice", `{"revision":1,"jobId":"slice"}`, "", 200)
	raw, err := os.ReadFile(filepath.Join(st.versionDir("project"), "slices", j.ID, "request.json"))
	if err != nil {
		t.Fatal(err)
	}
	var kept JobRequest
	if err := json.Unmarshal(raw, &kept); err != nil {
		t.Fatal(err)
	}
	if kept.ProjectSnapshot == nil || kept.ProjectSnapshot.PlateIndex != 2 {
		t.Fatalf("slice lost its plate: %+v", kept.ProjectSnapshot)
	}
	delete(s.jobs.jobs, j.ID)
	w := sharedRequest(t, mux, "POST", "/api/versions/project/1/open-slice", `{}`, "", 200)
	var view JobView
	if err := json.Unmarshal(w.Body.Bytes(), &view); err != nil {
		t.Fatal(err)
	}
	if view.Request.ProjectSnapshot == nil || view.Request.ProjectSnapshot.PlateIndex != 2 {
		t.Fatal("history returned the wrong slice plate")
	}
}
