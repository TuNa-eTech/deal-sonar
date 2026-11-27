-- A variant is an independent radar created from an existing one. The link only records
-- provenance: leads, evaluations and feedback stay attached to the radar (and version) that
-- produced them, and the variant starts with its own empty history.
ALTER TABLE radars ADD COLUMN variant_of TEXT REFERENCES radars(id) ON DELETE SET NULL;
CREATE INDEX idx_radars_variant_of ON radars(variant_of) WHERE variant_of IS NOT NULL;
