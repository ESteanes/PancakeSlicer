package main

import (
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"sort"
	"strings"
	"time"
	"unicode/utf16"
)

type filamentAssignment struct {
	Slot    int    `json:"slot"`
	SpoolID string `json:"spoolId"`
}

type filamentPrintUsage struct {
	SpoolID string  `json:"spoolId"`
	Name    string  `json:"name"`
	Grams   float64 `json:"grams"`
}

type filamentPrintRecord struct {
	ID     string               `json:"id"`
	JobID  string               `json:"jobId"`
	Name   string               `json:"name"`
	At     int64                `json:"at"`
	Usage  []filamentPrintUsage `json:"usage"`
	Digest string               `json:"digest"`
}

type filamentPrintLedger struct {
	Prints map[string]filamentPrintRecord `json:"prints"`
}

func readFilamentPrintLedger(d *workspaceData) (filamentPrintLedger, error) {
	ledger := filamentPrintLedger{Prints: map[string]filamentPrintRecord{}}
	if raw := d.Values["filament-prints"].Document; raw != nil {
		if err := json.Unmarshal(raw, &ledger); err != nil || ledger.Prints == nil {
			return ledger, errors.New("Print history could not be read. Keep the current inventory and retry.")
		}
	}
	return ledger, nil
}

func (s *Server) filamentPrintRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/filament-inventory/prints", func(w http.ResponseWriter, r *http.Request) {
		s.workspace.view(w, func(d *workspaceData) {
			ledger, err := readFilamentPrintLedger(d)
			if err != nil {
				workspaceFailure(w, 503, "print_history_unavailable", err.Error(), "retry_storage", 0)
				return
			}
			rows := []filamentPrintRecord{}
			for _, row := range ledger.Prints {
				if job := r.URL.Query().Get("jobId"); job == "" || row.JobID == job {
					rows = append(rows, row)
				}
			}
			sort.Slice(rows, func(i, j int) bool { return rows[i].At > rows[j].At })
			writeJSON(w, 200, rows)
		})
	})
	mux.HandleFunc("POST /api/filament-inventory/prints", s.recordFilamentPrint)
}

func (s *Server) recordFilamentPrint(w http.ResponseWriter, r *http.Request) {
	var in struct {
		PrintID          string               `json:"printId"`
		JobID            string               `json:"jobId"`
		Name             string               `json:"name"`
		ExpectedRevision *uint64              `json:"expectedRevision"`
		Assignments      []filamentAssignment `json:"assignments"`
	}
	if !workspaceDecode(w, r, &in) {
		return
	}
	if !workspaceID(in.PrintID) || !workspaceID(in.JobID) || in.ExpectedRevision == nil || strings.TrimSpace(in.Name) == "" || len(utf16.Encode([]rune(in.Name))) > 200 || len(in.Assignments) == 0 || len(in.Assignments) > 256 {
		workspaceFailure(w, 400, "invalid_inventory_print", "A print ID, slice job, name, inventory revision and spool assignments are required.", "review_print", 0)
		return
	}
	assignments := map[int]string{}
	for _, assignment := range in.Assignments {
		if assignment.Slot < 0 || assignment.Slot > 255 || !workspaceID(assignment.SpoolID) || assignments[assignment.Slot] != "" {
			workspaceFailure(w, 400, "invalid_inventory_print", "Each used filament must have one inventory spool.", "review_print", 0)
			return
		}
		assignments[assignment.Slot] = assignment.SpoolID
	}
	digest := workspaceDigest([]any{in.JobID, in.Name, assignments})
	s.workspace.locked(w, func(d *workspaceData) {
		ledger, err := readFilamentPrintLedger(d)
		if err != nil {
			workspaceFailure(w, 503, "print_history_unavailable", err.Error(), "retry_storage", 0)
			return
		}
		value := d.Values["filament-inventory"]
		respond := func(row filamentPrintRecord) {
			writeJSON(w, 200, map[string]any{"print": row, "revision": value.Revision, "document": value.Document})
		}
		if recorded, exists := ledger.Prints[in.PrintID]; exists {
			if recorded.Digest != digest {
				workspaceFailure(w, 409, "inventory_print_conflict", "This print was already recorded with different spool assignments. Reload its history.", "review_print", value.Revision)
				return
			}
			respond(recorded)
			return
		}
		if value.Revision != *in.ExpectedRevision {
			workspaceFailure(w, 409, "revision_conflict", "Inventory changed. Reload and review the remaining weights before recording this print.", "reload_and_reapply", value.Revision)
			return
		}
		job := s.jobs.Get(in.JobID)
		if job == nil {
			workspaceFailure(w, 410, "inventory_slice_unavailable", "This slice is no longer available. Slice the plate again before recording a print.", "slice_again", value.Revision)
			return
		}
		view := job.View()
		var record struct {
			Statistics struct {
				Extruders []struct {
					Slot  *int     `json:"extruder_id"`
					Grams *float64 `json:"used_filament_g"`
				} `json:"per_extruder"`
			} `json:"statistics"`
		}
		if view.State != StateDone || view.Request.Calib != "" || json.Unmarshal(view.Slice, &record) != nil || len(record.Statistics.Extruders) == 0 || len(record.Statistics.Extruders) > 256 {
			workspaceFailure(w, 400, "invalid_inventory_print", "A completed plate slice with filament weight estimates is required.", "slice_again", value.Revision)
			return
		}
		used := map[string]float64{}
		seen := map[int]bool{}
		for _, extruder := range record.Statistics.Extruders {
			if extruder.Slot == nil || extruder.Grams == nil || *extruder.Slot < 0 || *extruder.Slot > 255 || seen[*extruder.Slot] || math.IsNaN(*extruder.Grams) || math.IsInf(*extruder.Grams, 0) || *extruder.Grams < 0 || *extruder.Grams > 1000000 {
				workspaceFailure(w, 400, "invalid_inventory_print", "This slice has invalid filament estimates. Slice the plate again.", "slice_again", value.Revision)
				return
			}
			seen[*extruder.Slot] = true
			if *extruder.Grams == 0 {
				continue
			}
			id := assignments[*extruder.Slot]
			if id == "" {
				workspaceFailure(w, 400, "invalid_inventory_print", "Select an inventory spool for every filament used by this slice.", "review_print", value.Revision)
				return
			}
			delete(assignments, *extruder.Slot)
			used[id] += *extruder.Grams
		}
		if len(used) == 0 || len(assignments) != 0 {
			workspaceFailure(w, 400, "invalid_inventory_print", "Spool assignments must match the filaments used by this slice.", "review_print", value.Revision)
			return
		}
		inventory := filamentInventory{Spools: []filamentSpool{}}
		if value.Document != nil && (json.Unmarshal(value.Document, &inventory) != nil || inventory.Spools == nil) {
			workspaceFailure(w, 503, "inventory_unavailable", "Saved inventory could not be read.", "retry_storage", value.Revision)
			return
		}
		usage := []filamentPrintUsage{}
		for i := range inventory.Spools {
			spool := &inventory.Spools[i]
			weight, ok := used[spool.ID]
			if !ok {
				continue
			}
			weight = math.Ceil(weight*1000) / 1000
			if spool.RemainingGrams == nil || weight > *spool.RemainingGrams {
				workspaceFailure(w, 409, "insufficient_filament", "Not enough filament remains on "+spool.Name+". Correct its measured weight or choose another spool.", "review_print", value.Revision)
				return
			}
			remaining := math.Round((*spool.RemainingGrams-weight)*1000000) / 1000000
			spool.RemainingGrams = &remaining
			usage = append(usage, filamentPrintUsage{spool.ID, spool.Name, weight})
			delete(used, spool.ID)
		}
		if len(used) != 0 {
			workspaceFailure(w, 409, "inventory_spool_missing", "A selected spool was deleted. Choose another spool before recording this print.", "review_print", value.Revision)
			return
		}
		row := filamentPrintRecord{ID: in.PrintID, JobID: in.JobID, Name: in.Name, At: time.Now().UnixMilli(), Usage: usage, Digest: digest}
		ledger.Prints[in.PrintID] = row
		inventoryDoc, _ := json.Marshal(inventory)
		ledgerDoc, _ := json.Marshal(ledger)
		value = workspaceValue{Revision: value.Revision + 1, Document: inventoryDoc}
		d.Values["filament-inventory"] = value
		d.Values["filament-prints"] = workspaceValue{Revision: d.Values["filament-prints"].Revision + 1, Document: ledgerDoc}
		if err := s.workspace.save(d); err != nil {
			workspaceFailure(w, 507, "workspace_write_failed", "Print usage could not be saved. Retry the same print recording.", "retry_same_operation", value.Revision)
			return
		}
		respond(row)
	})
}
