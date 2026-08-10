use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value;
use sqlx::{PgConnection, PgPool, Postgres, QueryBuilder, Transaction};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct AppointmentConflictRow {
    pub appointment_id: Uuid,
    pub customer_display_name: Option<String>,
    pub appointment_type: String,
    pub starts_at: DateTime<Utc>,
    pub ends_at: DateTime<Utc>,
    pub salesperson: Option<String>,
    pub salesperson_staff_id: Option<Uuid>,
    pub resource_names: Vec<String>,
}

pub fn canonical_status(value: &str) -> Option<&'static str> {
    match value.trim().to_ascii_lowercase().as_str() {
        "scheduled" => Some("Scheduled"),
        "attended" => Some("Attended"),
        "missed" | "no_show" | "noshow" => Some("Missed"),
        "cancelled" | "canceled" => Some("Cancelled"),
        _ => None,
    }
}

pub fn validate_time_range(starts_at: DateTime<Utc>, ends_at: DateTime<Utc>) -> Result<(), String> {
    let minutes = (ends_at - starts_at).num_minutes();
    if !(15..=480).contains(&minutes) {
        return Err("Appointment duration must be between 15 minutes and 8 hours.".to_string());
    }
    Ok(())
}

pub async fn service_duration_minutes(
    pool: &PgPool,
    service_type_id: Option<Uuid>,
    appointment_type: &str,
) -> Result<i32, sqlx::Error> {
    if let Some(service_type_id) = service_type_id {
        let duration = sqlx::query_scalar::<_, i32>(
            "SELECT duration_minutes FROM appointment_service_type WHERE id = $1 AND is_active = TRUE",
        )
        .bind(service_type_id)
        .fetch_optional(pool)
        .await?;
        return Ok(duration.unwrap_or(60));
    }
    let code = appointment_type.trim().to_ascii_lowercase();
    let duration = sqlx::query_scalar::<_, i32>(
        "SELECT duration_minutes FROM appointment_service_type WHERE code = $1 AND is_active = TRUE",
    )
    .bind(code)
    .fetch_optional(pool)
    .await?;
    Ok(duration.unwrap_or(60))
}

async fn lock_booking_dimensions(
    tx: &mut Transaction<'_, Postgres>,
    salesperson_staff_id: Option<Uuid>,
    resource_ids: &[Uuid],
) -> Result<(), sqlx::Error> {
    if let Some(staff_id) = salesperson_staff_id {
        let _ = sqlx::query_scalar::<_, Uuid>("SELECT id FROM staff WHERE id = $1 FOR UPDATE")
            .bind(staff_id)
            .fetch_optional(&mut **tx)
            .await?;
    }
    if !resource_ids.is_empty() {
        let mut ordered = resource_ids.to_vec();
        ordered.sort_unstable();
        ordered.dedup();
        let _ = sqlx::query_scalar::<_, Uuid>(
            "SELECT id FROM appointment_resource WHERE id = ANY($1) ORDER BY id FOR UPDATE",
        )
        .bind(&ordered)
        .fetch_all(&mut **tx)
        .await?;
    }
    Ok(())
}

pub async fn validate_booking_dimensions_locked(
    tx: &mut Transaction<'_, Postgres>,
    service_type_id: Option<Uuid>,
    resource_ids: &[Uuid],
) -> Result<Option<String>, sqlx::Error> {
    if let Some(service_type_id) = service_type_id {
        let active = sqlx::query_scalar::<_, Uuid>(
            "SELECT id FROM appointment_service_type WHERE id = $1 AND is_active = TRUE FOR UPDATE",
        )
        .bind(service_type_id)
        .fetch_optional(&mut **tx)
        .await?;
        if active.is_none() {
            return Ok(Some(
                "Selected appointment service type is no longer available.".to_string(),
            ));
        }
    }

    let mut unique_resources = resource_ids.to_vec();
    unique_resources.sort_unstable();
    unique_resources.dedup();
    if !unique_resources.is_empty() {
        let active = sqlx::query_scalar::<_, Uuid>(
            "SELECT id FROM appointment_resource WHERE id = ANY($1) AND is_active = TRUE ORDER BY id FOR UPDATE",
        )
        .bind(&unique_resources)
        .fetch_all(&mut **tx)
        .await?;
        if active.len() != unique_resources.len() {
            return Ok(Some(
                "One or more selected appointment resources are no longer available.".to_string(),
            ));
        }
    }

    Ok(None)
}

pub async fn find_conflicts_locked(
    tx: &mut Transaction<'_, Postgres>,
    exclude_appointment_id: Option<Uuid>,
    salesperson_staff_id: Option<Uuid>,
    resource_ids: &[Uuid],
    starts_at: DateTime<Utc>,
    ends_at: DateTime<Utc>,
) -> Result<Vec<AppointmentConflictRow>, sqlx::Error> {
    lock_booking_dimensions(tx, salesperson_staff_id, resource_ids).await?;
    find_conflicts_on_connection(
        &mut **tx,
        exclude_appointment_id,
        salesperson_staff_id,
        resource_ids,
        starts_at,
        ends_at,
    )
    .await
}

async fn find_conflicts_on_connection(
    connection: &mut PgConnection,
    exclude_appointment_id: Option<Uuid>,
    salesperson_staff_id: Option<Uuid>,
    resource_ids: &[Uuid],
    starts_at: DateTime<Utc>,
    ends_at: DateTime<Utc>,
) -> Result<Vec<AppointmentConflictRow>, sqlx::Error> {
    sqlx::query_as::<_, AppointmentConflictRow>(
        r#"
        SELECT
            wa.id AS appointment_id,
            wa.customer_display_name,
            wa.appointment_type,
            wa.starts_at,
            wa.ends_at,
            wa.salesperson,
            wa.salesperson_staff_id,
            COALESCE(array_agg(DISTINCT ar.name) FILTER (WHERE ar.name IS NOT NULL), ARRAY[]::text[]) AS resource_names
        FROM wedding_appointments wa
        LEFT JOIN appointment_resource_assignment ara ON ara.appointment_id = wa.id
        LEFT JOIN appointment_resource ar ON ar.id = ara.resource_id
        WHERE wa.status = 'Scheduled'
          AND ($1::uuid IS NULL OR wa.id <> $1)
          AND wa.starts_at < $5
          AND wa.ends_at > $4
          AND (
              ($2::uuid IS NOT NULL AND wa.salesperson_staff_id = $2)
              OR (
                  COALESCE(cardinality($3::uuid[]), 0) > 0
                  AND ara.resource_id = ANY($3)
                  AND EXISTS (
                      SELECT 1
                      FROM appointment_resource requested
                      WHERE requested.id = ara.resource_id
                        AND EXISTS (
                            SELECT 1
                            FROM (
                                SELECT $4::timestamptz AS point_in_time
                                UNION
                                SELECT GREATEST(existing.starts_at, $4)
                                FROM appointment_resource_assignment existing_assignment
                                JOIN wedding_appointments existing
                                  ON existing.id = existing_assignment.appointment_id
                                WHERE existing_assignment.resource_id = requested.id
                                  AND existing.status = 'Scheduled'
                                  AND ($1::uuid IS NULL OR existing.id <> $1)
                                  AND existing.starts_at < $5
                                  AND existing.ends_at > $4
                            ) candidate_point
                            WHERE (
                                SELECT COUNT(DISTINCT active.id)
                                FROM appointment_resource_assignment active_assignment
                                JOIN wedding_appointments active
                                  ON active.id = active_assignment.appointment_id
                                WHERE active_assignment.resource_id = requested.id
                                  AND active.status = 'Scheduled'
                                  AND ($1::uuid IS NULL OR active.id <> $1)
                                  AND active.starts_at <= candidate_point.point_in_time
                                  AND active.ends_at > candidate_point.point_in_time
                            ) >= requested.capacity
                        )
                  )
              )
          )
        GROUP BY wa.id
        ORDER BY wa.starts_at, wa.id
        "#,
    )
    .bind(exclude_appointment_id)
    .bind(salesperson_staff_id)
    .bind(resource_ids)
    .bind(starts_at)
    .bind(ends_at)
    .fetch_all(connection)
    .await
}

pub async fn list_conflicts(
    pool: &PgPool,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
) -> Result<Vec<AppointmentConflictRow>, sqlx::Error> {
    sqlx::query_as::<_, AppointmentConflictRow>(
        r#"
        SELECT DISTINCT ON (wa.id)
            wa.id AS appointment_id,
            wa.customer_display_name,
            wa.appointment_type,
            wa.starts_at,
            wa.ends_at,
            wa.salesperson,
            wa.salesperson_staff_id,
            COALESCE(resources.names, ARRAY[]::text[]) AS resource_names
        FROM wedding_appointments wa
        LEFT JOIN LATERAL (
            SELECT array_agg(ar.name ORDER BY ar.name) AS names
            FROM appointment_resource_assignment ara
            JOIN appointment_resource ar ON ar.id = ara.resource_id
            WHERE ara.appointment_id = wa.id
        ) resources ON TRUE
        WHERE wa.status = 'Scheduled'
          AND wa.starts_at < $2
          AND wa.ends_at > $1
          AND (
              (
                  wa.salesperson_staff_id IS NOT NULL
                  AND EXISTS (
                      SELECT 1 FROM wedding_appointments other
                      WHERE other.id <> wa.id
                        AND other.status = 'Scheduled'
                        AND other.salesperson_staff_id = wa.salesperson_staff_id
                        AND other.starts_at < wa.ends_at
                        AND other.ends_at > wa.starts_at
                  )
              )
              OR EXISTS (
                  SELECT 1
                  FROM appointment_resource_assignment mine
                  JOIN appointment_resource resource ON resource.id = mine.resource_id
                  WHERE mine.appointment_id = wa.id
                    AND EXISTS (
                        SELECT 1
                        FROM appointment_resource_assignment candidate_assignment
                        JOIN wedding_appointments candidate
                          ON candidate.id = candidate_assignment.appointment_id
                        WHERE candidate_assignment.resource_id = mine.resource_id
                          AND candidate.status = 'Scheduled'
                          AND candidate.starts_at < wa.ends_at
                          AND candidate.ends_at > wa.starts_at
                          AND (
                              SELECT COUNT(DISTINCT active.id)
                              FROM appointment_resource_assignment active_assignment
                              JOIN wedding_appointments active
                                ON active.id = active_assignment.appointment_id
                              WHERE active_assignment.resource_id = mine.resource_id
                                AND active.status = 'Scheduled'
                                AND active.starts_at <= GREATEST(candidate.starts_at, wa.starts_at)
                                AND active.ends_at > GREATEST(candidate.starts_at, wa.starts_at)
                          ) > resource.capacity
                    )
              )
          )
        ORDER BY wa.id, wa.starts_at
        "#,
    )
    .bind(from)
    .bind(to)
    .fetch_all(pool)
    .await
}

pub async fn replace_resources(
    tx: &mut Transaction<'_, Postgres>,
    appointment_id: Uuid,
    resource_ids: &[Uuid],
) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM appointment_resource_assignment WHERE appointment_id = $1")
        .bind(appointment_id)
        .execute(&mut **tx)
        .await?;
    let mut unique = resource_ids.to_vec();
    unique.sort_unstable();
    unique.dedup();
    for resource_id in unique {
        sqlx::query(
            "INSERT INTO appointment_resource_assignment (appointment_id, resource_id) VALUES ($1, $2)",
        )
        .bind(appointment_id)
        .bind(resource_id)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

pub async fn resource_ids(pool: &PgPool, appointment_id: Uuid) -> Result<Vec<Uuid>, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT resource_id FROM appointment_resource_assignment WHERE appointment_id = $1 ORDER BY resource_id",
    )
    .bind(appointment_id)
    .fetch_all(pool)
    .await
}

pub async fn insert_audit(
    connection: &mut PgConnection,
    appointment_id: Uuid,
    action: &str,
    actor_staff_id: Option<Uuid>,
    before_state: Option<Value>,
    after_state: Option<Value>,
    reason: Option<&str>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO appointment_audit (
            appointment_id, action, actor_staff_id, before_state, after_state, reason
        ) VALUES ($1, $2, $3, $4, $5, $6)
        "#,
    )
    .bind(appointment_id)
    .bind(action)
    .bind(actor_staff_id)
    .bind(before_state)
    .bind(after_state)
    .bind(reason.map(str::trim).filter(|value| !value.is_empty()))
    .execute(connection)
    .await?;
    Ok(())
}

pub fn push_optional_resource_filter<'a>(
    qb: &mut QueryBuilder<'a, Postgres>,
    resource_id: Option<Uuid>,
) {
    if let Some(resource_id) = resource_id {
        qb.push(
            " AND EXISTS (SELECT 1 FROM appointment_resource_assignment ara WHERE ara.appointment_id = wedding_appointments.id AND ara.resource_id = ",
        )
        .push_bind(resource_id)
        .push(") ");
    }
}

#[cfg(test)]
mod tests {
    use super::{canonical_status, validate_time_range};
    use chrono::{Duration, Utc};

    #[test]
    fn status_normalization_matches_staff_workflow() {
        assert_eq!(canonical_status("Attended"), Some("Attended"));
        assert_eq!(canonical_status("no_show"), Some("Missed"));
        assert_eq!(canonical_status("bogus"), None);
    }

    #[test]
    fn appointment_duration_has_safe_bounds() {
        let start = Utc::now();
        assert!(validate_time_range(start, start + Duration::minutes(15)).is_ok());
        assert!(validate_time_range(start, start + Duration::minutes(480)).is_ok());
        assert!(validate_time_range(start, start + Duration::minutes(5)).is_err());
        assert!(validate_time_range(start, start + Duration::minutes(481)).is_err());
    }
}
