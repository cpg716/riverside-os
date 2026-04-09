//! Normalize POS fulfillment writes (reject legacy `custom`, map wedding vs special).

use uuid::Uuid;

use crate::models::DbFulfillmentType;

/// Maps API fulfillment to stored enum. Rejects legacy `custom` on write.
/// Wedding checkouts persist non-takeaway lines as `wedding_order` when `wedding_member_id` is set.
pub fn persist_fulfillment(
    wedding_member_id: Option<Uuid>,
    fulfillment: DbFulfillmentType,
) -> Result<DbFulfillmentType, &'static str> {
    match fulfillment {
        DbFulfillmentType::Custom => {
            Err("fulfillment type 'custom' is no longer supported; use special_order")
        }
        DbFulfillmentType::Takeaway => Ok(DbFulfillmentType::Takeaway),
        DbFulfillmentType::WeddingOrder => {
            if wedding_member_id.is_some() {
                Ok(DbFulfillmentType::WeddingOrder)
            } else {
                Ok(DbFulfillmentType::SpecialOrder)
            }
        }
        DbFulfillmentType::SpecialOrder => {
            if wedding_member_id.is_some() {
                Ok(DbFulfillmentType::WeddingOrder)
            } else {
                Ok(DbFulfillmentType::SpecialOrder)
            }
        }
        DbFulfillmentType::Layaway => Ok(DbFulfillmentType::Layaway),
    }
}
