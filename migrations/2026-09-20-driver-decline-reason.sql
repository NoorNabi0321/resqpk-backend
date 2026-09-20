-- Why a driver turned an emergency down.
--
-- Dispatch already records that an offer was declined; it never recorded why.
-- That distinction matters: "I am on another case" is the system working, while
-- "the patient is too far" or a broken vehicle is a dispatch or fleet problem
-- someone should be able to see in the data.
--
-- Nullable on purpose. A decline with no reason (or a timeout, which is not a
-- decline at all) stays exactly as it was.
alter table case_driver_requests
  add column if not exists decline_reason text;

comment on column case_driver_requests.decline_reason is
  'on_another_case | too_far | vehicle_issue | not_available | other — null for timeouts and older rows';

-- History and the driver stats both read by driver and time.
create index if not exists idx_case_driver_requests_driver_notified
  on case_driver_requests (driver_id, notified_at desc);
