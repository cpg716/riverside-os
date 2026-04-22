//! Normalize POS fulfillment writes while preserving the Special / Custom / Wedding split.

use uuid::Uuid;

use crate::models::DbFulfillmentType;

/// Maps API fulfillment to the stored enum.
/// Wedding checkouts persist non-takeaway lines as `wedding_order` when `wedding_member_id` is set.
/// Special and Custom remain distinct stored fulfillment types because downstream
/// receiving, reservation, and reporting flows still rely on that split.
pub fn persist_fulfillment(
    wedding_member_id: Option<Uuid>,
    fulfillment: DbFulfillmentType,
) -> Result<DbFulfillmentType, &'static str> {
    match fulfillment {
        DbFulfillmentType::Custom => Ok(DbFulfillmentType::Custom),
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

#[cfg(test)]
mod tests {
    use super::persist_fulfillment;
    use crate::models::DbFulfillmentType;
    use uuid::Uuid;

    #[test]
    fn custom_orders_remain_custom_without_wedding_context() {
        let persisted = persist_fulfillment(None, DbFulfillmentType::Custom)
            .expect("custom fulfillment should persist");
        assert_eq!(persisted, DbFulfillmentType::Custom);
    }

    #[test]
    fn special_orders_upgrade_to_wedding_when_member_is_present() {
        let persisted = persist_fulfillment(Some(Uuid::new_v4()), DbFulfillmentType::SpecialOrder)
            .expect("special order should persist");
        assert_eq!(persisted, DbFulfillmentType::WeddingOrder);
    }

    #[test]
    fn custom_orders_stay_custom_even_for_wedding_linked_checkout() {
        let persisted = persist_fulfillment(Some(Uuid::new_v4()), DbFulfillmentType::Custom)
            .expect("custom fulfillment should persist");
        assert_eq!(persisted, DbFulfillmentType::Custom);
    }
}
