-- Reusable aggregate for placement-drive management and reporting.
SET search_path = erp, public;

CREATE OR REPLACE VIEW v_placement_drive_summary AS
SELECT d.drive_id,d.company_id,c.company_name,d.title,d.role_title,d.drive_type,d.status,d.deadline,
       d.package_lpa,d.stipend_monthly,
       count(DISTINCT a.application_id)::int AS applicants,
       count(DISTINCT o.offer_id)::int AS offers,
       count(DISTINCT o.offer_id) FILTER (WHERE o.status='Accepted')::int AS accepted_offers
  FROM placement_drive d
  JOIN company c USING (company_id)
  LEFT JOIN placement_application a USING (drive_id)
  LEFT JOIN placement_offer o USING (application_id)
 GROUP BY d.drive_id,c.company_name;

GRANT SELECT ON v_placement_drive_summary TO erp_app;
