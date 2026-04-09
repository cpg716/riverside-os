//! Product template + variant pricing shapes for override inheritance.

use rust_decimal::Decimal;

/// Template-level list prices (single source on `products`).
#[derive(Debug, Clone, Copy)]
pub struct ProductTemplateRef {
    pub base_retail_price: Decimal,
    pub base_cost: Decimal,
}

/// Per-SKU optional overrides (`product_variants`).
#[derive(Debug, Clone, Copy)]
pub struct ProductVariantPricing {
    pub retail_price_override: Option<Decimal>,
    pub cost_override: Option<Decimal>,
}

impl ProductVariantPricing {
    pub fn effective_retail_usd(&self, template: &ProductTemplateRef) -> Decimal {
        crate::logic::template_variant_pricing::effective_retail_usd(
            template.base_retail_price,
            self.retail_price_override,
        )
    }

    pub fn effective_cost_usd(&self, template: &ProductTemplateRef) -> Decimal {
        crate::logic::template_variant_pricing::effective_cost_usd(
            template.base_cost,
            self.cost_override,
        )
    }
}
