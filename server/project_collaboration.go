package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"time"
)

type editLock struct {
	Session string `json:"session"`
	Label   string `json:"label"`
	Token   string `json:"token,omitempty"`
	Expires int64  `json:"expires"`
}
type projectSnapshotRef struct {
	ID         string `json:"id"`
	Revision   uint64 `json:"revision"`
	Version    uint64 `json:"version"`
	PlateIndex int    `json:"plateIndex,omitempty"`
}

func (st *workspaceStore) validProjectSnapshot(snapshot projectSnapshotRef) bool {
	if st == nil || !workspaceID(snapshot.ID) || snapshot.Version == 0 || snapshot.Revision == 0 || snapshot.PlateIndex < 0 {
		return false
	}
	st.mu.Lock()
	defer st.mu.Unlock()
	index, err := st.readVersions(snapshot.ID)
	if err != nil {
		return false
	}
	for _, version := range index.Versions {
		if version.ID == snapshot.Version && version.Revision == snapshot.Revision && version.Sealed {
			return true
		}
	}
	return false
}

type sharedRecord struct {
	Meta          map[string]any  `json:"meta"`
	Doc           map[string]any  `json:"doc"`
	JobReferences json.RawMessage `json:"jobReferences,omitempty"`
}
type sharedObject struct {
	Plate  int            `json:"plate"`
	Order  float64        `json:"order"`
	Object map[string]any `json:"object"`
}
type sharedSettings struct {
	Fields map[string]any   `json:"fields"`
	Plates []map[string]any `json:"plates"`
}
type sharedChange struct {
	Key    string          `json:"key"`
	Before json.RawMessage `json:"before"`
	After  json.RawMessage `json:"after"`
	Token  string          `json:"token"`
}

func jsonValue(v any) json.RawMessage { raw, _ := json.Marshal(v); return raw }
func sameJSON(a, b json.RawMessage) bool {
	var x, y any
	if len(a) == 0 {
		a = json.RawMessage("null")
	}
	if len(b) == 0 {
		b = json.RawMessage("null")
	}
	return json.Unmarshal(a, &x) == nil && json.Unmarshal(b, &y) == nil && reflect.DeepEqual(x, y)
}
func sharedNumber(v any) float64 { n, _ := v.(float64); return n }
func validSharedID(value any) bool {
	n, ok := value.(float64)
	return ok && n > 0 && n <= 9007199254740991 && math.Trunc(n) == n
}
func validEditKey(key string) bool {
	if key == "settings" {
		return true
	}
	if !strings.HasPrefix(key, "object:") {
		return false
	}
	n, err := strconv.ParseUint(strings.TrimPrefix(key, "object:"), 10, 53)
	return err == nil && n > 0 && key == fmt.Sprintf("object:%d", n)
}
func (st *workspaceStore) liveEditLocks(id string) map[string]*editLock {
	if st.objectLocks == nil {
		st.objectLocks = map[string]map[string]*editLock{}
	}
	locks := st.objectLocks[id]
	if locks == nil {
		locks = map[string]*editLock{}
		st.objectLocks[id] = locks
	}
	for key, lock := range locks {
		if lock.Expires <= time.Now().UnixMilli() {
			delete(locks, key)
		}
	}
	return locks
}
func (st *workspaceStore) editStatus(id, session string, revision uint64) any {
	locks := map[string]editLock{}
	for key, lock := range st.liveEditLocks(id) {
		copy := *lock
		if copy.Session != session {
			copy.Token = ""
		}
		locks[key] = copy
	}
	return map[string]any{"revision": revision, "locks": locks, "ttlMs": leaseTTL.Milliseconds(), "now": time.Now().UnixMilli()}
}
func (st *workspaceStore) checkEditLock(w http.ResponseWriter, id, key, session, token string, revision uint64) bool {
	lock := st.liveEditLocks(id)[key]
	if lock != nil && token != "" && lock.Token == token && lock.Session == session {
		return true
	}
	message := "Your editing lock expired. Reload the latest project and acquire the lock again."
	if lock != nil && lock.Session != session {
		message = fmt.Sprintf("%s is being edited by %s.", key, lock.Label)
	}
	body := workspaceError("edit_lock_required", message, "reload_and_reapply", revision)
	body["resource"] = key
	writeJSON(w, 409, body)
	return false
}

func splitSharedRecord(record sharedRecord) (map[string]json.RawMessage, error) {
	doc := record.Doc
	if doc == nil {
		return nil, errors.New("Project document is missing.")
	}
	fields := map[string]any{}
	for k, v := range doc {
		switch k {
		case "objects", "projectPlates", "plateIndex", "selected", "events", "files", "recoveryCheckpoint", "collaborationOrder", "projectNotice":
			continue
		}
		fields[k] = v
	}
	active := int(sharedNumber(doc["plateIndex"]))
	if active == 0 {
		active = 1
	}
	plates, _ := doc["projectPlates"].([]any)
	if len(plates) == 0 {
		plates = []any{map[string]any{"index": float64(active), "name": "", "origin": []any{float64(0), float64(0)}, "settings": map[string]any{}}}
	}
	orders, _ := doc["collaborationOrder"].(map[string]any)
	resources := map[string]json.RawMessage{}
	settings := sharedSettings{Fields: fields}
	seenPlates := map[int]bool{}
	for _, value := range plates {
		plate, ok := value.(map[string]any)
		if !ok {
			return nil, errors.New("Invalid plate.")
		}
		index := int(sharedNumber(plate["index"]))
		if !validSharedID(plate["index"]) || seenPlates[index] {
			return nil, errors.New("Plate IDs must be unique positive integers.")
		}
		seenPlates[index] = true
		metadata := map[string]any{}
		for key, v := range plate {
			if key != "objects" {
				metadata[key] = v
			}
		}
		list, _ := plate["objects"].([]any)
		if index == active {
			list, _ = doc["objects"].([]any)
			metadata["events"] = doc["events"]
		}
		if metadata["events"] == nil {
			metadata["events"] = []any{}
		}
		settings.Plates = append(settings.Plates, metadata)
		for i, value := range list {
			object, ok := value.(map[string]any)
			id := sharedNumber(object["id"])
			if !ok || !validSharedID(object["id"]) {
				return nil, errors.New("Invalid object ID.")
			}
			key := fmt.Sprintf("object:%.0f", id)
			if resources[key] != nil {
				return nil, errors.New("Object IDs must be unique across the project.")
			}
			order := sharedNumber(orders[fmt.Sprintf("%.0f", id)])
			if order <= 0 {
				order = float64(i + 1)
			}
			resources[key] = jsonValue(sharedObject{Plate: index, Order: order, Object: object})
		}
	}
	resources["settings"] = jsonValue(settings)
	return resources, nil
}

func joinSharedRecord(record sharedRecord, resources map[string]json.RawMessage) (sharedRecord, error) {
	var settings sharedSettings
	if json.Unmarshal(resources["settings"], &settings) != nil || settings.Fields == nil || len(settings.Plates) == 0 {
		return record, errors.New("Shared settings and at least one plate are required.")
	}
	objects := []sharedObject{}
	for key, raw := range resources {
		if key == "settings" {
			continue
		}
		var object sharedObject
		if json.Unmarshal(raw, &object) != nil || !validSharedID(object.Object["id"]) || object.Order <= 0 || math.IsNaN(object.Order) || math.IsInf(object.Order, 0) || key != fmt.Sprintf("object:%.0f", sharedNumber(object.Object["id"])) {
			return record, errors.New("Invalid shared object.")
		}
		objects = append(objects, object)
	}
	sort.Slice(objects, func(i, j int) bool {
		if objects[i].Order == objects[j].Order {
			return sharedNumber(objects[i].Object["id"]) < sharedNumber(objects[j].Object["id"])
		}
		return objects[i].Order < objects[j].Order
	})
	plates := []any{}
	seen := map[int]bool{}
	for _, plate := range settings.Plates {
		index := int(sharedNumber(plate["index"]))
		if !validSharedID(plate["index"]) || seen[index] {
			return record, errors.New("Invalid plate ID.")
		}
		seen[index] = true
		list := []any{}
		for _, object := range objects {
			if object.Plate == index {
				list = append(list, object.Object)
			}
		}
		plate["objects"] = list
		plates = append(plates, plate)
	}
	orders := map[string]any{}
	for _, object := range objects {
		if !seen[object.Plate] {
			return record, errors.New("Move or delete the objects on a plate before deleting that plate.")
		}
		orders[fmt.Sprintf("%.0f", sharedNumber(object.Object["id"]))] = object.Order
	}
	first := settings.Plates[0]
	doc := settings.Fields
	doc["projectPlates"], doc["plateIndex"], doc["objects"], doc["events"] = plates, first["index"], first["objects"], first["events"]
	doc["files"], doc["collaborationOrder"], doc["selected"] = record.Doc["files"], orders, nil
	record.Doc = doc
	record.Meta["objects"] = len(objects)
	if name, ok := doc["projectName"].(string); ok && strings.TrimSpace(name) != "" {
		record.Meta["name"] = name
	}
	return record, nil
}

func (st *workspaceStore) authorizeProjectCommand(w http.ResponseWriter, r *http.Request, id string, p workspaceProject, action string) bool {
	var tokens map[string]string
	json.Unmarshal([]byte(r.Header.Get("X-Orca-Edit-Locks")), &tokens)
	keys := []string{"settings"}
	if action == "archive" {
		var record sharedRecord
		json.Unmarshal(p.Record, &record)
		resources, err := splitSharedRecord(record)
		if err != nil {
			workspaceFailure(w, 400, "project_invalid", err.Error(), "reload", p.Revision)
			return false
		}
		for key := range resources {
			if key != "settings" {
				keys = append(keys, key)
			}
		}
	}
	for _, key := range keys {
		if !st.checkEditLock(w, id, key, r.Header.Get(sessionHeader), tokens[key], p.Revision) {
			return false
		}
	}
	return true
}

func (st *workspaceStore) collaborationRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/projects/{id}/collaboration", func(w http.ResponseWriter, r *http.Request) {
		st.locked(w, func(d *workspaceData) {
			id := r.PathValue("id")
			p, ok := d.Projects[id]
			if !ok || p.Record == nil {
				workspaceFailure(w, 404, "project_missing", "Project not found.", "open_projects", 0)
				return
			}
			if !validSession(r.Header.Get(sessionHeader)) {
				workspaceFailure(w, 400, "session_invalid", "An editing session is required.", "reload", p.Revision)
				return
			}
			if !p.Collaborative {
				if st.leaseConflict(w, id, r.Header.Get(sessionHeader), p.Revision) {
					return
				}
				var record sharedRecord
				json.Unmarshal(p.Record, &record)
				if _, err := splitSharedRecord(record); err != nil {
					workspaceFailure(w, 400, "project_invalid", err.Error(), "reload", p.Revision)
					return
				}
				p.Collaborative = true
				d.Projects[id] = p
				if err := st.save(d); err != nil {
					workspaceFailure(w, 507, "workspace_write_failed", err.Error(), "retry_storage", p.Revision)
					return
				}
				delete(st.leaseTable(), id)
				st.saveLeases()
			}
			writeJSON(w, 200, st.editStatus(id, r.Header.Get(sessionHeader), p.Revision))
		})
	})
	mux.HandleFunc("POST /api/projects/{id}/locks", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Action string            `json:"action"`
			Keys   []string          `json:"keys"`
			Tokens map[string]string `json:"tokens"`
			Label  string            `json:"label"`
		}
		if !workspaceDecode(w, r, &in) {
			return
		}
		session := r.Header.Get(sessionHeader)
		if !validSession(session) || len(in.Keys) > 10000 || len(in.Label) > 120 {
			workspaceFailure(w, 400, "lock_invalid", "Invalid editing lock request.", "reload", 0)
			return
		}
		if in.Action != "acquire" && in.Action != "renew" && in.Action != "release" {
			workspaceFailure(w, 400, "lock_invalid", "Unknown editing lock action.", "reload", 0)
			return
		}
		st.locked(w, func(d *workspaceData) {
			id := r.PathValue("id")
			p, ok := d.Projects[id]
			if !ok || p.Record == nil || !p.Collaborative {
				workspaceFailure(w, 409, "collaboration_required", "Join the shared project before editing.", "reload", p.Revision)
				return
			}
			locks := st.liveEditLocks(id)
			for _, key := range in.Keys {
				if !validEditKey(key) {
					workspaceFailure(w, 400, "lock_invalid", "Invalid editing resource.", "reload", p.Revision)
					return
				}
				lock := locks[key]
				if in.Action == "release" {
					continue
				}
				if lock != nil && lock.Session != session {
					workspaceFailure(w, 409, "edit_lock_held", fmt.Sprintf("%s is being edited by %s.", key, lock.Label), "wait_for_editor", p.Revision)
					return
				}
				if in.Action == "renew" || lock != nil && in.Tokens[key] != "" {
					if !st.checkEditLock(w, id, key, session, in.Tokens[key], p.Revision) {
						return
					}
				}
			}
			newTokens := map[string]string{}
			for _, key := range in.Keys {
				if in.Action == "acquire" && locks[key] == nil {
					var b [24]byte
					if _, err := rand.Read(b[:]); err != nil {
						workspaceFailure(w, 503, "lock_unavailable", "Editing locks are temporarily unavailable.", "retry", p.Revision)
						return
					}
					newTokens[key] = hex.EncodeToString(b[:])
				}
			}
			for _, key := range in.Keys {
				lock := locks[key]
				if in.Action == "release" {
					if lock != nil && lock.Session == session && lock.Token == in.Tokens[key] {
						delete(locks, key)
					}
					continue
				}
				if lock == nil {
					label := strings.TrimSpace(in.Label)
					if label == "" {
						label = "another editor"
					}
					lock = &editLock{Session: session, Label: label, Token: newTokens[key]}
					locks[key] = lock
				}
				lock.Expires = time.Now().Add(leaseTTL).UnixMilli()
			}
			writeJSON(w, 200, st.editStatus(id, session, p.Revision))
		})
	})
	mux.HandleFunc("POST /api/projects/{id}/changes", st.applyProjectChanges)
	mux.HandleFunc("GET /api/projects/{id}/collaboration/events", st.projectEditEvents)
}

func (st *workspaceStore) applyProjectChanges(w http.ResponseWriter, r *http.Request) {
	var in struct {
		OperationID string            `json:"operationId"`
		Changes     []sharedChange    `json:"changes"`
		Files       map[string]string `json:"files"`
		Checkpoint  json.RawMessage   `json:"checkpoint"`
		Thumbnail   json.RawMessage   `json:"thumbnail,omitempty"`
		Change      []versionChange   `json:"change,omitempty"`
	}
	if !workspaceDecode(w, r, &in) {
		return
	}
	if len(in.Changes) == 0 || len(in.Changes) > 10000 {
		workspaceFailure(w, 400, "change_invalid", "A save must contain between 1 and 10000 resource changes.", "reload", 0)
		return
	}
	st.locked(w, func(d *workspaceData) {
		id := r.PathValue("id")
		p, ok := d.Projects[id]
		digest := workspaceDigest([]any{id, in})
		if workspaceReplay(w, d, in.OperationID, digest) {
			return
		}
		if !ok || p.Record == nil || p.Archived {
			workspaceFailure(w, 410, "project_archived", "This project is no longer available for editing.", "open_projects", p.Revision)
			return
		}
		if !p.Collaborative {
			workspaceFailure(w, 409, "collaboration_required", "Join the shared project before saving.", "reload", p.Revision)
			return
		}
		var record sharedRecord
		json.Unmarshal(p.Record, &record)
		resources, err := splitSharedRecord(record)
		if err != nil {
			workspaceFailure(w, 400, "project_invalid", err.Error(), "reload", p.Revision)
			return
		}
		seen := map[string]bool{}
		for _, change := range in.Changes {
			if !validEditKey(change.Key) || seen[change.Key] {
				workspaceFailure(w, 400, "change_invalid", "Invalid or duplicate editing resource.", "reload", p.Revision)
				return
			}
			seen[change.Key] = true
			if !st.checkEditLock(w, id, change.Key, r.Header.Get(sessionHeader), change.Token, p.Revision) {
				return
			}
			if !sameJSON(resources[change.Key], change.Before) {
				workspaceFailure(w, 409, "revision_conflict", "An object or shared setting changed. Reload the latest project before editing it.", "reload_and_reapply", p.Revision)
				return
			}
			if sameJSON(change.After, json.RawMessage("null")) {
				delete(resources, change.Key)
			} else {
				resources[change.Key] = change.After
			}
		}
		record, err = joinSharedRecord(record, resources)
		if err != nil {
			workspaceFailure(w, 400, "change_invalid", err.Error(), "reload", p.Revision)
			return
		}
		files, _ := record.Doc["files"].(map[string]any)
		if files == nil {
			files = map[string]any{}
		}
		for key, name := range in.Files {
			if _, exists := files[key]; !exists {
				files[key] = name
			}
		}
		used := map[string]any{}
		keep := func(value any) bool {
			if value == nil {
				return true
			}
			key, ok := value.(string)
			name, exists := files[key]
			if !ok || !exists {
				return false
			}
			used[key] = name
			return true
		}
		validFiles := keep(record.Doc["project"])
		for _, plate := range record.Doc["projectPlates"].([]any) {
			for _, value := range plate.(map[string]any)["objects"].([]any) {
				object := value.(map[string]any)
				validFiles = keep(object["source"]) && validFiles
				if native, ok := object["native"].(map[string]any); ok {
					if refs, ok := native["files"].(map[string]any); ok {
						for _, ref := range refs {
							validFiles = keep(ref) && validFiles
						}
					}
				}
			}
		}
		if !validFiles {
			workspaceFailure(w, 400, "project_invalid", "A model file is missing from the project manifest.", "reload", p.Revision)
			return
		}
		record.Doc["files"] = used
		if len(in.Checkpoint) > 0 {
			var checkpoint any
			json.Unmarshal(in.Checkpoint, &checkpoint)
			record.Doc["recoveryCheckpoint"] = checkpoint
		}
		p.Revision++
		record.Meta["savedAt"] = time.Now().UnixMilli()
		if len(in.Thumbnail) > 0 {
			var thumbnail any
			json.Unmarshal(in.Thumbnail, &thumbnail)
			record.Meta["thumbnail"] = thumbnail
		}
		p.Record, err = projectRecord(jsonValue(record), id, p.Revision)
		if err == nil {
			err = st.checkAssets(p.Record)
		}
		if err != nil {
			workspaceFailure(w, 400, "project_invalid", err.Error(), "reload", p.Revision)
			return
		}
		d.Projects[id] = p
		response := map[string]any{"revision": p.Revision, "operationId": in.OperationID}
		if st.commit(w, d, in.OperationID, digest, response) {
			st.recordVersion(id, p.Revision, p.Record, in.Change, "save")
		}
	})
}

func (st *workspaceStore) projectEditEvents(w http.ResponseWriter, r *http.Request) {
	id, session := r.PathValue("id"), r.Header.Get(sessionHeader)
	label := strings.TrimSpace(r.URL.Query().Get("label"))
	if !validSession(session) || len(label) > 120 {
		workspaceFailure(w, 400, "session_invalid", "A valid project session is required.", "reload", 0)
		return
	}
	if label == "" {
		label = "Browser"
	}
	viewer := &projectViewer{session: session, label: label, since: time.Now().UnixMilli()}
	registered := false
	defer st.removeProjectViewer(id, viewer)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	controller := http.NewResponseController(w)
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	previous := ""
	for {
		st.mu.Lock()
		d, err := st.read()
		var raw []byte
		deleted := false
		if err == nil {
			p, ok := d.Projects[id]
			if !ok || p.Archived || p.Record == nil {
				deleted = true
				raw = []byte(`{"deleted":true}`)
			} else {
				if !registered {
					st.addProjectViewer(id, viewer)
					registered = true
				}
				raw, _ = json.Marshal(st.editStatus(id, session, p.Revision))
			}
		}
		st.mu.Unlock()
		if err != nil {
			return
		}
		controller.SetWriteDeadline(time.Now().Add(10 * time.Second))
		if string(raw) != previous {
			if _, err = fmt.Fprintf(w, "data: %s\n\n", raw); err != nil {
				return
			}
			previous = string(raw)
		} else {
			if _, err = fmt.Fprint(w, ": keepalive\n\n"); err != nil {
				return
			}
		}
		if controller.Flush() != nil || deleted {
			return
		}
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
		}
	}
}
