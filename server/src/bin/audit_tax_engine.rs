use rust_decimal::Decimal;
use rust_decimal_macros::dec;
use riverside_server::logic::tax::{TaxCategory, nys_erie_total_sales_tax_usd};

fn main() {
    println!("Auditing Tax Engine (NYS/NYC $110 Exemption)...");

    // Scenario 1: Clothing under $110
    // Expected: State tax is 0, Local tax is active (4.75%)
    let price_under = dec!(95.00);
    let tax_under = nys_erie_total_sales_tax_usd(TaxCategory::Clothing, price_under, price_under);
    let expected_under = dec!(4.51); // 95 * 0.0475 = 4.5125 -> 4.51
    println!("Clothing $95.00 -> Tax: ${} (Expected: ${})", tax_under, expected_under);
    assert_eq!(tax_under, expected_under);

    // Scenario 2: Clothing exactly $110
    // Expected: State tax (4%) + Local tax (4.75%) = 8.75%
    let price_exact = dec!(110.00);
    let tax_exact = nys_erie_total_sales_tax_usd(TaxCategory::Clothing, price_exact, price_exact);
    let expected_exact = dec!(9.63); // 110 * 0.0875 = 9.625 -> 9.63
    println!("Clothing $110.00 -> Tax: ${} (Expected: ${})", tax_exact, expected_exact);
    assert_eq!(tax_exact, expected_exact);

    // Scenario 3: Clothing over $110
    let price_over = dec!(150.00);
    let tax_over = nys_erie_total_sales_tax_usd(TaxCategory::Clothing, price_over, price_over);
    let expected_over = dec!(13.13); // 150 * 0.0875 = 13.125 -> 13.13
    println!("Clothing $150.00 -> Tax: ${} (Expected: ${})", tax_over, expected_over);
    assert_eq!(tax_over, expected_over);

    // Scenario 4: Other (e.g. Accessory) under $110
    // Expected: Always fully taxable (8.75%)
    let price_other = dec!(50.00);
    let tax_other = nys_erie_total_sales_tax_usd(TaxCategory::Other, price_other, price_other);
    let expected_other = dec!(4.38); // 50 * 0.0875 = 4.375 -> 4.38
    println!("Accessory $50.00 -> Tax: ${} (Expected: ${})", tax_other, expected_other);
    assert_eq!(tax_other, expected_other);

    println!("AUDIT PASSED: NYS/NYC $110 Exemption threshold logic is mathematically sound.");
}
