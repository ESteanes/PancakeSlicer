package main

import (
	"encoding/json"
	"errors"
	"math"
	"regexp"
	"strings"
	"unicode/utf16"
)

type filamentSpool struct {
	ID              string   `json:"id"`
	Name            string   `json:"name"`
	Brand           *string  `json:"brand"`
	Material        string   `json:"material"`
	Colour          string   `json:"colour"`
	ColourName      string   `json:"colourName"`
	CapacityGrams   *float64 `json:"capacityGrams"`
	RemainingGrams  *float64 `json:"remainingGrams"`
	Location        *string  `json:"location"`
	DiameterMM      *float64 `json:"diameterMm,omitempty"`
	DensityGramsCM3 *float64 `json:"densityGramsCm3,omitempty"`
}

var inventoryColour = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

type filamentInventory struct {
	Spools []filamentSpool `json:"spools"`
}

func filamentInventoryDocument(raw json.RawMessage) (json.RawMessage, error) {
	var doc struct {
		Spools *[]filamentSpool `json:"spools"`
	}
	if json.Unmarshal(raw, &doc) != nil || doc.Spools == nil || len(*doc.Spools) > 10000 {
		return nil, errors.New("Inventory must contain a list of up to 10,000 spools.")
	}
	ids := make(map[string]bool, len(*doc.Spools))
	for _, spool := range *doc.Spools {
		if !workspaceID(spool.ID) || ids[spool.ID] {
			return nil, errors.New("Each spool must have a unique, valid ID.")
		}
		ids[spool.ID] = true
		for _, value := range []string{spool.Name, spool.Material, spool.ColourName} {
			if strings.TrimSpace(value) == "" || len(utf16.Encode([]rune(value))) > 100 {
				return nil, errors.New("Spool name, material and colour name are required and must be at most 100 characters.")
			}
		}
		if spool.Brand == nil || spool.Location == nil || len(utf16.Encode([]rune(*spool.Brand))) > 100 || len(utf16.Encode([]rune(*spool.Location))) > 200 || !inventoryColour.MatchString(spool.Colour) {
			return nil, errors.New("Provide a valid HEX colour, brand of up to 100 characters and location of up to 200 characters.")
		}
		if spool.CapacityGrams == nil || spool.RemainingGrams == nil {
			return nil, errors.New("Spool capacity and remaining weight are required.")
		}
		capacity, remaining := *spool.CapacityGrams, *spool.RemainingGrams
		if math.IsNaN(capacity) || math.IsInf(capacity, 0) || math.IsNaN(remaining) || math.IsInf(remaining, 0) || capacity <= 0 || capacity > 1000000 || remaining < 0 || remaining > capacity {
			return nil, errors.New("Capacity must be greater than zero and no more than 1,000,000 g, and remaining weight must be between zero and capacity.")
		}
		if diameter := spool.DiameterMM; diameter != nil && (math.IsNaN(*diameter) || math.IsInf(*diameter, 0) || *diameter <= 0 || *diameter > 10) {
			return nil, errors.New("Diameter must be greater than zero and no more than 10 mm.")
		}
		if density := spool.DensityGramsCM3; density != nil && (math.IsNaN(*density) || math.IsInf(*density, 0) || *density <= 0 || *density > 30) {
			return nil, errors.New("Density must be greater than zero and no more than 30 g/cm³.")
		}
	}
	return json.Marshal(doc)
}
