-- Add Riverside's canonical GL-number catalog and pair it with the live QBO chart.
-- Account numbers are text identifiers so values such as 1210-0 and 8510-0 remain exact.

CREATE TABLE IF NOT EXISTS ros_gl_accounts (
    account_number text PRIMARY KEY,
    account_name text NOT NULL,
    account_type text NOT NULL,
    income_tax_line text,
    is_active boolean NOT NULL DEFAULT true,
    updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ros_gl_accounts_number_chk CHECK (BTRIM(account_number) <> ''),
    CONSTRAINT ros_gl_accounts_name_chk CHECK (BTRIM(account_name) <> '')
);

COMMENT ON TABLE ros_gl_accounts IS
  'Riverside canonical GL-number reference used to review ROS-to-QBO account mappings. QBO account ids remain the posting destination.';

INSERT INTO ros_gl_accounts (account_number, account_name, account_type, income_tax_line)
VALUES
    ('1005', 'Checking - M&T', 'Bank', 'B/S-Assets: Cash'),
    ('1006', 'Savings - M&T', 'Bank', 'B/S-Assets: Cash'),
    ('1120', 'Inventory Asset', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1200', 'Accounts Receivable', 'Accounts Receivable', 'B/S-Assets: Accts. Rec. and trade notes'),
    ('1205', 'Trade-Jeff Kirisits ACE Sealing', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1206', 'Trade - Chris McCaffrey (Sign)', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1207', 'Trade - Queen City Shirt Co', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1208', 'Trade - Cumulus', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1209', 'Trade N2Publications', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1210-0', 'R2S Receivable', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1211', 'R2S Reserve', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1212', 'Other Receivables', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1213', 'Payroll Tax Receivable', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1215', 'Employee Store Charge', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1215-1', 'Tom Lanighan', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1215-10', 'Anthony Polichetti', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1215-11', 'Samantha Lopez', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1215-2', 'Mandy Palmer', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1215-3', 'Tom Williams', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1215-4', 'Mike Vartazaryants', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1215-5', 'Brenden Robinson', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1215-6', 'Paul Polino', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1215-7', 'Stephen Parisi', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1215-8', 'Lori Gray', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1215-9', 'Jerrod Miner', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1250', 'Prepaid NYS Tax', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1300', 'Inventory', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1301-0', 'Suit', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1301-1', 'Hart''s Suit', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1301-2', 'Jack Victor Suit', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1301-3', 'Blue Lion Suit', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1301-4', 'HSM Custom Suit', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1304', 'Bflo Sweatshirt/T-shirt', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1306-0', 'Topcoat', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1306-1', 'Hart''s Topcoat', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1307', 'Raincoat', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1311-0', 'Sport Coat', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1311-1', 'Hart''s Sport Coat', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1311-2', 'Jack Victor Sport Coat', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1311-3', 'Blue Lion Sport Coat', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1311-4', 'HSM Custom Sport Coat', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1328', 'Dress Shirt', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1329', 'Sport Shirt', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1331', 'Custom Dress Shirt', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1332', 'Ties', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1334', 'Blazer Buttons', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1335', 'Hat/Cap', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1336', 'Gloves', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1337', 'Scarf', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1338', 'Umbrella', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1339', 'Hosiery/Garters', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1340', 'Hanky/Pocket Square', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1341', 'Jewelry', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1342', 'Cologne/Toiletries', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1343', 'Miscellaneous', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1344', 'Outerwear', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1346', 'Wallet', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1347', 'Pajamas', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1348', 'Robe', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1355', 'Sweater', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1356', 'Vests', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1357', 'Blankets', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1358-0', 'Men''s Slack', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1358-1', 'Hart''s Slack', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1358-2', 'Jack Victor Slack', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1358-3', 'Blue Lion Slack', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1358-4', 'HSM Custom Slacks', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1360', 'Jeans', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1368', 'Walk Shorts', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1369', 'Swimwear', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1371', 'Shoes/Boots', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1373', 'Slippers', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1374', 'Rubbers', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1376', 'Shoe Polish/Cream', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1377', 'Shoe Laces', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1378', 'Shoe Trees', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1379', 'Recraft Shoes', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1381', 'Belt', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1382', 'Braces/Suspenders', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1383', 'Underwear/T-shirts', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1387', 'QC Sport Shirts', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1390', 'Tuxedo', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1391', 'Formal Tie', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1392', 'Cummerbund', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1393', 'Cummerbund/Tie Set', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1394', 'Formal Shirt', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1301', 'Inventory Allowance', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1405', 'Will Call (Layaway)', 'Other Current Asset', 'B/S-Assets: Cash'),
    ('1450', 'Gift Certificate Receivable', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1451', 'IMS Trade', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1499', 'Undeposited Funds', 'Other Current Asset', 'B/S-Assets: Other current assets'),
    ('1500', 'Computer Equipment', 'Fixed Asset', 'B/S-Assets: Buildings/oth. depr. assets'),
    ('1520', 'Furniture & Fixtures', 'Fixed Asset', 'B/S-Assets: Buildings/oth. depr. assets'),
    ('1530', 'Toyota Automobile', 'Fixed Asset', 'B/S-Assets: Buildings/oth. depr. assets'),
    ('1531', 'BMW Auto', 'Fixed Asset', 'B/S-Assets: Buildings/oth. depr. assets'),
    ('1540', 'Leasehold Improvements', 'Fixed Asset', 'B/S-Assets: Buildings/oth. depr. assets'),
    ('1590', 'Accumulated Depreciation', 'Fixed Asset', 'B/S-Assets: Buildings/oth. depr. assets'),
    ('1700', 'Receivable-Neumann Landholdings', 'Other Asset', 'B/S-Assets: Other assets'),
    ('1800', 'Utility Deposit', 'Other Asset', 'B/S-Assets: Other assets'),
    ('1801', 'National Fuel', 'Other Asset', 'B/S-Assets: Other assets'),
    ('1802', 'National Grid', 'Other Asset', 'B/S-Assets: Other current assets'),
    ('1803', 'Rent Deposit - Eggert', 'Other Asset', 'B/S-Assets: Other assets'),
    ('1850', 'Customer List/Goodwill', 'Other Asset', 'B/S-Assets: Other assets'),
    ('1851', 'Accum. Amort. Cust/Goodwill', 'Other Asset', 'B/S-Assets: Other assets'),
    ('1860', 'Loan Closing Costs', 'Other Asset', 'B/S-Assets: Other assets'),
    ('1861', 'Accum. Amort. Loan Closing Cost', 'Other Asset', 'B/S-Assets: Other assets'),
    ('2', 'Purchase Orders', 'Non-Posting', '<Unassigned>'),
    ('2000', 'Accounts Payable', 'Accounts Payable', 'B/S-Liabs/Eq.: Accounts payable'),
    ('2001', 'Other Accounts Payable', 'Other Current Liability', 'B/S-Liabs/Eq.: Other current liabilities'),
    ('2002', 'Other A/P - S&E', 'Other Current Liability', 'B/S-Liabs/Eq.: Other current liabilities'),
    ('2050', 'Accrued NYS Franchise Tax', 'Other Current Liability', 'B/S-Liabs/Eq.: Other current liabilities'),
    ('2100', 'Payroll Liabilities', 'Other Current Liability', 'B/S-Liabs/Eq.: Other current liabilities'),
    ('2105', 'FICA Witholding', 'Other Current Liability', 'B/S-Liabs/Eq.: Other current liabilities'),
    ('2110', 'Federal Witholding', 'Other Current Liability', 'B/S-Liabs/Eq.: Other current liabilities'),
    ('2115', 'NYS Witholding', 'Other Current Liability', 'B/S-Liabs/Eq.: Other current liabilities'),
    ('2116', 'Simple IRA - Payable', 'Other Current Liability', 'B/S-Liabs/Eq.: Other current liabilities'),
    ('2120', 'M & T Line of Credit', 'Other Current Liability', 'B/S-Liabs/Eq.: Other current liabilities'),
    ('2121', 'M&T Demand Note', 'Other Current Liability', 'B/S-Liabs/Eq.: Other current liabilities'),
    ('2122', 'M & T Line of Credit (2)', 'Other Current Liability', 'B/S-Liabs/Eq.: Other current liabilities'),
    ('2123', 'SBA (COVID-19)', 'Other Current Liability', 'B/S-Liabs/Eq.: Other current liabilities'),
    ('2150', 'Sales Tax Payable 8.75%', 'Other Current Liability', 'B/S-Liabs/Eq.: Other current liabilities'),
    ('2151', 'Sales Tax Payable 4.75%', 'Other Current Liability', 'B/S-Liabs/Eq.: Other current liabilities'),
    ('2152', 'NY State Sales Tax Refund', 'Other Current Liability', 'B/S-Liabs/Eq.: Other current liabilities'),
    ('2200', 'Customer Deposits/Retainers', 'Other Current Liability', '<Unassigned>'),
    ('2201', 'Will Call (Deferred Revenue)', 'Other Current Liability', 'B/S-Liabs/Eq.: Other current liabilities'),
    ('2250', 'Gift Certificate Liability', 'Other Current Liability', 'B/S-Liabs/Eq.: Other current liabilities'),
    ('2251', 'Due Bill', 'Other Current Liability', 'B/S-Liabs/Eq.: Other current liabilities'),
    ('2252', 'Gift Certificate Liab - Donated', 'Other Current Liability', 'B/S-Liabs/Eq.: Other current liabilities'),
    ('2300', 'Shareholder Loan', 'Long Term Liability', 'B/S-Liabs/Eq.: L-T Mortgage/note/bonds pay.'),
    ('2301', 'Accrued Interest', 'Long Term Liability', 'B/S-Liabs/Eq.: L-T Mortgage/note/bonds pay.'),
    ('2310', 'Capital Lease Payable', 'Long Term Liability', 'B/S-Liabs/Eq.: L-T Mortgage/note/bonds pay.'),
    ('2320', 'HS Loan', 'Long Term Liability', 'B/S-Liabs/Eq.: L-T Mortgage/note/bonds pay.'),
    ('2330', 'S&E Payable', 'Other Current Liability', 'B/S-Liabs/Eq.: Other current liabilities'),
    ('2335', 'M & T Loan', 'Long Term Liability', 'B/S-Liabs/Eq.: L-T Mortgage/note/bonds pay.'),
    ('2336', 'Loan Payable- BMW', 'Other Current Liability', 'B/S-Liabs/Eq.: L-T Mortgage/note/bonds pay.'),
    ('2338', 'Toyota Auto Loan', 'Other Current Liability', 'B/S-Liabs/Eq.: Other current liabilities'),
    ('2340', 'VCC Loan Payable', 'Other Current Liability', 'B/S-Liabs/Eq.: Other current liabilities'),
    ('3000', 'Opening Bal Equity', 'Equity', '<Unassigned>'),
    ('3100', 'Capital Stock', 'Equity', '<Unassigned>'),
    ('3200', 'Distribution', 'Equity', '<Unassigned>'),
    ('3300', 'Additional Paid in Capital', 'Equity', '<Unassigned>'),
    ('3900', 'Retained Earnings', 'Equity', '<Unassigned>'),
    ('4', 'Estimates', 'Non-Posting', '<Unassigned>'),
    ('4000', 'Reconciliation Discrepancies', 'Expense', '<Unassigned>'),
    ('4010', 'Management Fee Income', 'Income', '<Unassigned>'),
    ('4100', 'Service Revenue', 'Income', 'Income: Gross receipts or sales not on line 1a'),
    ('4200', 'Product Revenue', 'Income', 'Income: Gross receipts or sales not on line 1a'),
    ('4201-0', 'Suits', 'Income', '<Unassigned>'),
    ('4201-1', 'Hart''s Suit', 'Income', '<Unassigned>'),
    ('4201-2', 'Jack Victor Suit', 'Income', '<Unassigned>'),
    ('4201-3', 'Blue Lion Suit', 'Income', '<Unassigned>'),
    ('4201-4', 'HSM Custom Suit', 'Income', '<Unassigned>'),
    ('4202', 'Cash Refund', 'Income', '<Unassigned>'),
    ('4203', 'Cash Refund on GC', 'Income', '<Unassigned>'),
    ('4206-0', 'Topcoat', 'Income', '<Unassigned>'),
    ('4206-1', 'Hart''s Topcoat', 'Income', '<Unassigned>'),
    ('4207', 'Raincoat', 'Income', '<Unassigned>'),
    ('4211-0', 'Sport Coat', 'Income', '<Unassigned>'),
    ('4211-1', 'Hart''s Sport Coat', 'Income', '<Unassigned>'),
    ('4211-2', 'Jack Victor Sport Coat', 'Income', '<Unassigned>'),
    ('4211-3', 'Blue Lion Sport Coat', 'Income', '<Unassigned>'),
    ('4211-4', 'HSM Custom Sport Coat', 'Income', '<Unassigned>'),
    ('4228', 'Dress Shirt', 'Income', '<Unassigned>'),
    ('4229', 'Sport Shirt', 'Income', '<Unassigned>'),
    ('4231', 'Custom Dress Shirt', 'Income', '<Unassigned>'),
    ('4232', 'Ties', 'Income', '<Unassigned>'),
    ('4234', 'Blazer Buttons', 'Income', '<Unassigned>'),
    ('4235', 'Hat/Cap', 'Income', '<Unassigned>'),
    ('4236', 'Gloves', 'Income', '<Unassigned>'),
    ('4237', 'Scarf', 'Income', '<Unassigned>'),
    ('4238', 'Umbrella', 'Income', '<Unassigned>'),
    ('4239', 'Hosiery/Garters', 'Income', '<Unassigned>'),
    ('4240', 'Hanky/ Pocket', 'Income', '<Unassigned>'),
    ('4241', 'Jewelry', 'Income', '<Unassigned>'),
    ('4242', 'Cologne', 'Income', '<Unassigned>'),
    ('4243', 'Miscellaneous', 'Income', '<Unassigned>'),
    ('4244', 'Outerwear', 'Income', '<Unassigned>'),
    ('4246', 'Wallet', 'Income', '<Unassigned>'),
    ('4247', 'Pajamas', 'Income', '<Unassigned>'),
    ('4248', 'Robe', 'Income', '<Unassigned>'),
    ('4255', 'Sweater', 'Income', '<Unassigned>'),
    ('4256', 'Vests', 'Income', '<Unassigned>'),
    ('4257', 'Blankets', 'Income', '<Unassigned>'),
    ('4258-0', 'Mens Slack', 'Income', '<Unassigned>'),
    ('4258-1', 'Hart''s Slack', 'Income', '<Unassigned>'),
    ('4258-2', 'Jack Victor Slack', 'Income', '<Unassigned>'),
    ('4258-3', 'Blue Lion Slack', 'Income', '<Unassigned>'),
    ('4258-4', 'HSM Custom Slacks', 'Income', '<Unassigned>'),
    ('4260', 'Jeans', 'Income', '<Unassigned>'),
    ('4268', 'Walk Shorts', 'Income', '<Unassigned>'),
    ('4271', 'Shoes/Boots', 'Income', '<Unassigned>'),
    ('4273', 'Slippers', 'Income', '<Unassigned>'),
    ('4274', 'Rubbers', 'Income', '<Unassigned>'),
    ('4276', 'Shoe Polish/Cream', 'Income', '<Unassigned>'),
    ('4277', 'Shoe Laces', 'Income', '<Unassigned>'),
    ('4278', 'Shoe Trees', 'Income', '<Unassigned>'),
    ('4279', 'Recraft Shoes', 'Income', '<Unassigned>'),
    ('4281', 'Belt', 'Income', '<Unassigned>'),
    ('4282', 'Braces/Suspenders', 'Income', '<Unassigned>'),
    ('4283', 'Underwear/T Shirts', 'Income', '<Unassigned>'),
    ('4287', 'QC Sport Shirts', 'Income', '<Unassigned>'),
    ('4287-1', 'QC Sport Shirts Consignment', 'Income', '<Unassigned>'),
    ('4290', 'Tuxedo', 'Income', '<Unassigned>'),
    ('4291', 'Formal Tie', 'Income', '<Unassigned>'),
    ('4292', 'Cummerbund', 'Income', '<Unassigned>'),
    ('4293', 'Cummerbund/Tie Set', 'Income', '<Unassigned>'),
    ('4294', 'Formal Shirt', 'Income', '<Unassigned>'),
    ('4295', 'Shipping', 'Income', '<Unassigned>'),
    ('4296', 'Alterations', 'Income', '<Unassigned>'),
    ('4296-1', 'Alterations - M. Wile', 'Income', '<Unassigned>'),
    ('4299', 'Dry Cleaning', 'Income', '<Unassigned>'),
    ('4205', 'Coupon', 'Income', '<Unassigned>'),
    ('4900', 'Reimbursed Expenses - Income', 'Income', 'Income: Gross receipts or sales not on line 1a'),
    ('4901', 'Discounts', 'Income', 'Income: Gross receipts or sales not on line 1a'),
    ('4902', 'Discount-Trade in Sale Offer', 'Income', 'Income: Gross receipts or sales not on line 1a'),
    ('4903', 'Loyalty Program', 'Income', 'Income: Gross receipts or sales not on line 1a'),
    ('4904', 'Discount-Buffalo News GC', 'Income', 'Income: Gross receipts or sales not on line 1a'),
    ('4990', 'Vendor Refunds', 'Income', 'Income: Other income'),
    ('4999', 'Cash over/Short', 'Income', '<Unassigned>'),
    ('5', 'Sales Orders', 'Non-Posting', '<Unassigned>'),
    ('5000', 'Project Related Costs', 'Cost of Goods Sold', 'COGS-Form 1125-A: Other costs'),
    ('5100', 'Outside Consultants', 'Cost of Goods Sold', 'COGS-Form 1125-A: Other costs'),
    ('5200', 'Reimbursable Expenses', 'Cost of Goods Sold', 'COGS-Form 1125-A: Other costs'),
    ('5300', 'Cost of Goods Sold', 'Cost of Goods Sold', '<Unassigned>'),
    ('5301-0', 'Suits', 'Cost of Goods Sold', '<Unassigned>'),
    ('5301-1', 'Hart''s Suit', 'Cost of Goods Sold', '<Unassigned>'),
    ('5301-2', 'Jack Victor Suit', 'Cost of Goods Sold', '<Unassigned>'),
    ('5301-3', 'Blue Lion Suit', 'Cost of Goods Sold', '<Unassigned>'),
    ('5301-4', 'HSM Custom Suit', 'Cost of Goods Sold', '<Unassigned>'),
    ('5306-0', 'Topcoat', 'Cost of Goods Sold', '<Unassigned>'),
    ('5306-1', 'Hart''s Topcoat', 'Cost of Goods Sold', '<Unassigned>'),
    ('5307', 'Raincoat', 'Cost of Goods Sold', '<Unassigned>'),
    ('5311-0', 'Sport Coat', 'Cost of Goods Sold', '<Unassigned>'),
    ('5311-1', 'Hart''s Sport Coat', 'Cost of Goods Sold', '<Unassigned>'),
    ('5311-2', 'Jack Victor Sport Coat', 'Cost of Goods Sold', '<Unassigned>'),
    ('5311-3', 'Blue Lion Sport Coat', 'Cost of Goods Sold', '<Unassigned>'),
    ('5311-4', 'HSM Custom Sport Coat', 'Cost of Goods Sold', '<Unassigned>'),
    ('5328', 'Dress Shirt', 'Cost of Goods Sold', '<Unassigned>'),
    ('5329', 'Sport Shirt', 'Cost of Goods Sold', '<Unassigned>'),
    ('5331', 'Custom Dress Shirt', 'Cost of Goods Sold', '<Unassigned>'),
    ('5332', 'Ties', 'Cost of Goods Sold', '<Unassigned>'),
    ('5334', 'Blazer Buttons', 'Cost of Goods Sold', '<Unassigned>'),
    ('5335', 'Hat/Cap', 'Cost of Goods Sold', '<Unassigned>'),
    ('5336', 'Gloves', 'Cost of Goods Sold', '<Unassigned>'),
    ('5337', 'Scarf', 'Cost of Goods Sold', '<Unassigned>'),
    ('5339', 'Hosiery/Garters', 'Cost of Goods Sold', '<Unassigned>'),
    ('5340', 'Hanky/Pocket', 'Cost of Goods Sold', '<Unassigned>'),
    ('5341', 'Jewelry', 'Cost of Goods Sold', '<Unassigned>'),
    ('5342', 'Cologne', 'Cost of Goods Sold', '<Unassigned>'),
    ('5343', 'Miscellaneous', 'Cost of Goods Sold', '<Unassigned>'),
    ('5344', 'Outerwear', 'Cost of Goods Sold', '<Unassigned>'),
    ('5346', 'Wallet', 'Cost of Goods Sold', '<Unassigned>'),
    ('5347', 'Pajamas', 'Cost of Goods Sold', '<Unassigned>'),
    ('5348', 'Robe', 'Cost of Goods Sold', '<Unassigned>'),
    ('5355', 'Sweater', 'Cost of Goods Sold', '<Unassigned>'),
    ('5356', 'Vests', 'Cost of Goods Sold', '<Unassigned>'),
    ('5357', 'Blankets', 'Cost of Goods Sold', '<Unassigned>'),
    ('5358-0', 'Mens Slack', 'Cost of Goods Sold', '<Unassigned>'),
    ('5358-1', 'Hart''s Slack', 'Cost of Goods Sold', '<Unassigned>'),
    ('5358-2', 'Jack Victor Slack', 'Cost of Goods Sold', '<Unassigned>'),
    ('5358-3', 'Blue Lion Slack', 'Cost of Goods Sold', '<Unassigned>'),
    ('5358-4', 'HSM Custom Slacks', 'Cost of Goods Sold', '<Unassigned>'),
    ('5360', 'Jeans', 'Cost of Goods Sold', '<Unassigned>'),
    ('5368', 'Walk Shorts', 'Cost of Goods Sold', '<Unassigned>'),
    ('5371', 'Shoes/Boots', 'Cost of Goods Sold', '<Unassigned>'),
    ('5373', 'Slippers', 'Cost of Goods Sold', '<Unassigned>'),
    ('5374', 'Rubbers', 'Cost of Goods Sold', '<Unassigned>'),
    ('5376', 'Shoe Polish/Cream', 'Cost of Goods Sold', '<Unassigned>'),
    ('5377', 'Shoe Laces', 'Cost of Goods Sold', '<Unassigned>'),
    ('5378', 'Shoe Trees', 'Cost of Goods Sold', '<Unassigned>'),
    ('5379', 'Recraft Shoes', 'Cost of Goods Sold', '<Unassigned>'),
    ('5381', 'Belt', 'Cost of Goods Sold', '<Unassigned>'),
    ('5382', 'Braces/Suspenders', 'Cost of Goods Sold', '<Unassigned>'),
    ('5383', 'Underwear', 'Cost of Goods Sold', '<Unassigned>'),
    ('5385', 'Screenprinting/Embroidery', 'Cost of Goods Sold', '<Unassigned>'),
    ('5387', 'QC Sport Shirts', 'Cost of Goods Sold', '<Unassigned>'),
    ('5387-1', 'QC Sport Shirts Consignment', 'Cost of Goods Sold', '<Unassigned>'),
    ('5390', 'Tuxedo', 'Cost of Goods Sold', '<Unassigned>'),
    ('5391', 'Formal Tie', 'Cost of Goods Sold', '<Unassigned>'),
    ('5392', 'Cummerbund', 'Cost of Goods Sold', '<Unassigned>'),
    ('5393', 'Cummerbund/Tie Set', 'Cost of Goods Sold', '<Unassigned>'),
    ('5394', 'Formal Shirt', 'Cost of Goods Sold', '<Unassigned>'),
    ('5395', 'Freight', 'Cost of Goods Sold', '<Unassigned>'),
    ('5395-1', 'Freight In', 'Cost of Goods Sold', '<Unassigned>'),
    ('5395-2', 'Freight Out - Vendor', 'Cost of Goods Sold', '<Unassigned>'),
    ('5395-3', 'Freight Out - Customer', 'Cost of Goods Sold', '<Unassigned>'),
    ('5396', 'Hangers', 'Cost of Goods Sold', '<Unassigned>'),
    ('5397', 'Packaging Supplies', 'Cost of Goods Sold', '<Unassigned>'),
    ('5399', 'CP Inventory Adjustment', 'Cost of Goods Sold', '<Unassigned>'),
    ('5410', 'Inventory Allowance Expense', 'Cost of Goods Sold', '<Unassigned>'),
    ('6100', 'Advertising Expense', 'Expense', 'Deductions: Advertising'),
    ('6110', 'Capital One Credit Card', 'Credit Card', 'B/S-Liabs/Eq.: Other current liabilities'),
    ('6111', 'M&T Credit Card', 'Credit Card', 'B/S-Liabs/Eq.: Other current liabilities'),
    ('6112', 'Chase Freedom Credit Card', 'Credit Card', 'B/S-Liabs/Eq.: Other current liabilities'),
    ('6113', 'M&T - "Bills" Credit Card', 'Credit Card', 'B/S-Liabs/Eq.: Other current liabilities'),
    ('6115', 'Bank Service Charges', 'Expense', 'Other Deductions: Other deductions'),
    ('6120', 'Business License & Fees', 'Expense', 'Deductions: Licenses'),
    ('6130', 'Car/Truck Expense', 'Expense', 'Other Deductions: Other deductions'),
    ('6132', 'Gas', 'Expense', 'Other Deductions: Other deductions'),
    ('6134', 'Auto Repairs & Maintenance', 'Expense', 'Other Deductions: Other deductions'),
    ('6136', 'Registration & License', 'Expense', 'Other Deductions: Other deductions'),
    ('6140', 'Cleaning/Janitorial', 'Expense', 'Deductions: Repairs and maintenance'),
    ('6145', 'Contributions', 'Expense', 'Schedule K-Deductions: Charitable contributions'),
    ('6150', 'Depreciation Expense', 'Other Expense', '<Unassigned>'),
    ('6151', 'Amortization Expense', 'Other Expense', '<Unassigned>'),
    ('6155', 'Dues and Subscriptions', 'Expense', 'Other Deductions: Other deductions'),
    ('6180', 'Insurance', 'Expense', 'Other Deductions: Other deductions'),
    ('6181', 'Disability Insurance', 'Expense', 'Other Deductions: Other deductions'),
    ('6182', 'Life Insurance', 'Expense', 'Other Deductions: Other deductions'),
    ('6184', 'Auto Insurance', 'Expense', 'Other Deductions: Other deductions'),
    ('6186', 'Professional Liability Ins', 'Expense', 'Other Deductions: Other deductions'),
    ('6188', 'General Liability Insurance', 'Expense', 'Other Deductions: Other deductions'),
    ('6189', 'Worker''s Compensation', 'Expense', 'Other Deductions: Other deductions'),
    ('6192', 'Medical Insurance', 'Expense', 'Other Deductions: Other deductions'),
    ('6193', 'FUTA', 'Expense', 'Other Deductions: Other deductions'),
    ('6194', 'SUTA', 'Expense', 'Other Deductions: Other deductions'),
    ('6195', 'Aflac', 'Expense', 'Other Deductions: Other deductions'),
    ('6196', 'AFT', 'Expense', 'Other Deductions: Other deductions'),
    ('6197', 'PFL', 'Expense', 'Other Deductions: Other deductions'),
    ('6198', 'Simple IRA Plan (ER Match)', 'Expense', '<Unassigned>'),
    ('6240', 'Merchant fees', 'Expense', '<Unassigned>'),
    ('6242', 'R2S Fees', 'Expense', '<Unassigned>'),
    ('6243', 'IMS Trade Fees', 'Expense', '<Unassigned>'),
    ('6245', 'Miscellaneous', 'Expense', 'Other Deductions: Other deductions'),
    ('6250', 'Office Equipment', 'Expense', 'Other Deductions: Other deductions'),
    ('6255', 'Postage and Delivery', 'Expense', 'Other Deductions: Other deductions'),
    ('6260', 'Cartons', 'Expense', '<Unassigned>'),
    ('6265', 'Printing and Reproduction', 'Expense', 'Other Deductions: Other deductions'),
    ('6270', 'Professional Development', 'Expense', 'Other Deductions: Other deductions'),
    ('6275', 'Professional Fees', 'Expense', 'Other Deductions: Other deductions'),
    ('6277', 'Accounting Fees', 'Expense', 'Other Deductions: Other deductions'),
    ('6278', 'Payroll Service Fees', 'Expense', 'Other Deductions: Other deductions'),
    ('6295', 'Rent', 'Expense', 'Deductions: Rents'),
    ('6296', 'Overhead/Support Expense', 'Expense', '<Unassigned>'),
    ('6299', 'Dry Cleaning', 'Expense', '<Unassigned>'),
    ('6300', 'Repairs', 'Expense', 'Deductions: Repairs and maintenance'),
    ('6302', 'Computer Repairs', 'Expense', 'Deductions: Repairs and maintenance'),
    ('6303', 'Building Repairs', 'Expense', '<Unassigned>'),
    ('6303-1', 'Tailor Shop Renovation 2009', 'Expense', '<Unassigned>'),
    ('6304', 'Equipment Repairs', 'Expense', 'Deductions: Repairs and maintenance'),
    ('6310', 'Office Supplies', 'Expense', 'Other Deductions: Other deductions'),
    ('6311', 'Tailor Supplies', 'Expense', '<Unassigned>'),
    ('6330', 'Marketing/Promotion', 'Expense', '<Unassigned>'),
    ('6333', 'Employee Training', 'Expense', '<Unassigned>'),
    ('6334', 'Meals and Entertainment', 'Expense', 'Deductions: Meals and entertainment (subj to 50% l'),
    ('6335', 'Employee Meals', 'Expense', '<Unassigned>'),
    ('6336', 'Travel', 'Expense', 'Other Deductions: Other deductions'),
    ('6337', 'Gifts', 'Expense', '<Unassigned>'),
    ('6340', 'Outside Services', 'Expense', '<Unassigned>'),
    ('6341', 'Security', 'Expense', '<Unassigned>'),
    ('6560', 'Payroll Expenses', 'Expense', '<Unassigned>'),
    ('6562', 'Employee Retention Credit', 'Expense', '<Unassigned>'),
    ('6561', 'Payroll Taxes', 'Expense', '<Unassigned>'),
    ('6600', 'Auto Expense', 'Expense', '<Unassigned>'),
    ('6610', 'Car Rental', 'Expense', '<Unassigned>'),
    ('6620', 'Cell Phone', 'Expense', '<Unassigned>'),
    ('6621', 'Telephone', 'Expense', '<Unassigned>'),
    ('6650', 'Small Tools and Equipment', 'Expense', '<Unassigned>'),
    ('6700', 'Utilities', 'Expense', '<Unassigned>'),
    ('6701', 'Cable/Internet Service', 'Expense', '<Unassigned>'),
    ('6705', 'Electric', 'Expense', '<Unassigned>'),
    ('6710', 'Gas', 'Expense', '<Unassigned>'),
    ('6715', 'Water', 'Expense', '<Unassigned>'),
    ('6720', 'Garbage Disposal', 'Expense', '<Unassigned>'),
    ('6999', 'Uncategorized Expenses', 'Expense', '<Unassigned>'),
    ('7100', 'Interest Income', 'Other Income', 'Income: Other income'),
    ('7200', 'Early Payment Discounts', 'Other Income', 'Income: Other income'),
    ('7300', 'Other Income', 'Other Income', 'Income: Other income'),
    ('7315', 'PPP Loan Forgiveness', 'Other Income', '<Unassigned>'),
    ('7400', 'Debt Forgiveness', 'Other Income', '<Unassigned>'),
    ('8000', 'Officer Salary', 'Other Expense', '<Unassigned>'),
    ('8001', 'Share Holder Health Insurance', 'Other Expense', '<Unassigned>'),
    ('8002', 'Simple IRA match -Officer', 'Other Expense', '<Unassigned>'),
    ('8030', 'Loss on Sale of Assets', 'Other Expense', '<Unassigned>'),
    ('8100', 'Interest Expense', 'Other Expense', 'Deductions: Interest expense'),
    ('8101', 'Lease Corp', 'Other Expense', '<Unassigned>'),
    ('8102', 'M&T LOC Interest', 'Other Expense', 'Deductions: Interest expense'),
    ('8103', 'SBA Loan interest', 'Other Expense', '<Unassigned>'),
    ('8104', 'BMW Loan Interest', 'Other Expense', '<Unassigned>'),
    ('8200', 'Other Expense', 'Other Expense', 'Other Deductions: Other deductions'),
    ('8205', 'Bad Debt Expense', 'Other Expense', '<Unassigned>'),
    ('8510-0', 'Deposits Forefeit', 'Other Income', '<Unassigned>'),
    ('9000', 'Taxes NYS Filing Fee', 'Other Expense', '<Unassigned>'),
    ('9100', 'NYS Franchise Tax', 'Other Expense', '<Unassigned>'),
    ('9101', 'Corporation Tax', 'Other Expense', '<Unassigned>'),
    ('9105', 'Penalty Account', 'Other Expense', '<Unassigned>'),
    ('9900', 'Correction account for CP', 'Other Expense', '<Unassigned>')
ON CONFLICT (account_number) DO UPDATE
SET
    account_name = EXCLUDED.account_name,
    account_type = EXCLUDED.account_type,
    income_tax_line = EXCLUDED.income_tax_line,
    is_active = true,
    updated_at = CURRENT_TIMESTAMP;

ALTER TABLE qbo_mappings
    ADD COLUMN IF NOT EXISTS ros_gl_account_number text;

ALTER TABLE qbo_mappings
    ALTER COLUMN qbo_account_id DROP NOT NULL,
    ALTER COLUMN qbo_account_name DROP NOT NULL;

ALTER TABLE ledger_mappings
    ADD COLUMN IF NOT EXISTS ros_gl_account_number text;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'qbo_mappings_ros_gl_account_number_fkey'
    ) THEN
        ALTER TABLE qbo_mappings
            ADD CONSTRAINT qbo_mappings_ros_gl_account_number_fkey
            FOREIGN KEY (ros_gl_account_number)
            REFERENCES ros_gl_accounts(account_number)
            ON UPDATE CASCADE ON DELETE RESTRICT;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'ledger_mappings_ros_gl_account_number_fkey'
    ) THEN
        ALTER TABLE ledger_mappings
            ADD CONSTRAINT ledger_mappings_ros_gl_account_number_fkey
            FOREIGN KEY (ros_gl_account_number)
            REFERENCES ros_gl_accounts(account_number)
            ON UPDATE CASCADE ON DELETE RESTRICT;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'qbo_mappings_qbo_pair_chk'
    ) THEN
        ALTER TABLE qbo_mappings
            ADD CONSTRAINT qbo_mappings_qbo_pair_chk
            CHECK ((qbo_account_id IS NULL) = (qbo_account_name IS NULL));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'qbo_mappings_has_account_chk'
    ) THEN
        ALTER TABLE qbo_mappings
            ADD CONSTRAINT qbo_mappings_has_account_chk
            CHECK (qbo_account_id IS NOT NULL OR ros_gl_account_number IS NOT NULL);
    END IF;
END $$;

COMMENT ON COLUMN qbo_mappings.ros_gl_account_number IS
  'Staff-reviewed Riverside GL number paired with the QBO posting account.';
COMMENT ON COLUMN ledger_mappings.ros_gl_account_number IS
  'Staff-reviewed Riverside GL number paired with the QBO posting account.';

-- Exact number parity with the current QBO cache is the strongest safe pre-population.
UPDATE qbo_mappings AS mapping
SET ros_gl_account_number = ros.account_number,
    updated_at = CURRENT_TIMESTAMP
FROM qbo_accounts_cache AS qbo
JOIN ros_gl_accounts AS ros
  ON BTRIM(qbo.account_number) = ros.account_number
WHERE mapping.qbo_account_id = qbo.id
  AND mapping.ros_gl_account_number IS NULL;

UPDATE ledger_mappings AS mapping
SET ros_gl_account_number = ros.account_number,
    updated_at = CURRENT_TIMESTAMP
FROM qbo_accounts_cache AS qbo
JOIN ros_gl_accounts AS ros
  ON BTRIM(qbo.account_number) = ros.account_number
WHERE mapping.qbo_account_id = qbo.id
  AND mapping.ros_gl_account_number IS NULL;

-- Pre-populate high-confidence ROS roles without changing any QBO posting account.
UPDATE qbo_mappings
SET ros_gl_account_number = CASE
        WHEN source_type = 'tax' AND source_id = 'SALES_TAX' THEN '2150'
        WHEN source_type = 'liability_deposit' AND source_id = 'default' THEN '2200'
        WHEN source_type = 'liability_gift_card' AND source_id = 'default' THEN '2250'
        WHEN source_type = 'liability_store_credit' AND source_id = 'default' THEN '2251'
        WHEN source_type = 'expense_loyalty' AND source_id = 'default' THEN '6330'
        WHEN source_type = 'expense_donated' AND source_id = 'default' THEN '6145'
        WHEN source_type = 'expense_merchant_fee' AND source_id = 'default' THEN '6240'
        WHEN source_type = 'income_shipping' AND source_id = 'default' THEN '4295'
        WHEN source_type = 'income_alterations' AND source_id = 'default' THEN '4296'
        WHEN source_type = 'income_forfeited_deposit' AND source_id = 'default' THEN '8510-0'
        WHEN source_type = 'tender' AND source_id IN ('helcim_card', 'credit_card', 'card_terminal', 'card_manual', 'card_saved', 'card_credit', 'cash', 'check') THEN '1499'
        WHEN source_type = 'tender' AND source_id = 'on_account' THEN '1200'
        WHEN source_type = 'tender' AND source_id = 'gift_card' THEN '2250'
        WHEN source_type = 'tender' AND source_id = 'exchange_credit' THEN '2251'
        WHEN source_type = 'custom_revenue' AND source_id = 'hsm_suit' THEN '4201-4'
        WHEN source_type = 'custom_inventory' AND source_id = 'hsm_suit' THEN '1301-4'
        WHEN source_type = 'custom_cogs' AND source_id = 'hsm_suit' THEN '5301-4'
        WHEN source_type = 'custom_revenue' AND source_id = 'hsm_sport_coat' THEN '4211-4'
        WHEN source_type = 'custom_inventory' AND source_id = 'hsm_sport_coat' THEN '1311-4'
        WHEN source_type = 'custom_cogs' AND source_id = 'hsm_sport_coat' THEN '5311-4'
        WHEN source_type = 'custom_revenue' AND source_id = 'hsm_slacks' THEN '4258-4'
        WHEN source_type = 'custom_inventory' AND source_id = 'hsm_slacks' THEN '1358-4'
        WHEN source_type = 'custom_cogs' AND source_id = 'hsm_slacks' THEN '5358-4'
        WHEN source_type = 'custom_revenue' AND source_id = 'individualized_shirt' THEN '4231'
        WHEN source_type = 'custom_inventory' AND source_id = 'individualized_shirt' THEN '1331'
        WHEN source_type = 'custom_cogs' AND source_id = 'individualized_shirt' THEN '5331'
        ELSE ros_gl_account_number
    END,
    updated_at = CURRENT_TIMESTAMP
WHERE ros_gl_account_number IS NULL;

WITH category_candidates AS (
    SELECT
        mapping.id AS mapping_id,
        ros.account_number,
        ROW_NUMBER() OVER (
            PARTITION BY mapping.id
            ORDER BY
                CASE WHEN ros.account_number LIKE '%-0' THEN 0 ELSE 1 END,
                LENGTH(ros.account_number),
                ros.account_number
        ) AS preference
    FROM qbo_mappings AS mapping
    JOIN categories AS category ON category.id::text = mapping.source_id
    JOIN ros_gl_accounts AS ros
      ON REGEXP_REPLACE(REGEXP_REPLACE(LOWER(ros.account_name), '[^a-z0-9]', '', 'g'), 's$', '')
       = REGEXP_REPLACE(REGEXP_REPLACE(LOWER(category.name), '[^a-z0-9]', '', 'g'), 's$', '')
    WHERE mapping.ros_gl_account_number IS NULL
      AND (
        (mapping.source_type = 'category_revenue' AND ros.account_type = 'Income' AND ros.account_number LIKE '42%')
        OR (mapping.source_type = 'category_inventory' AND ros.account_type = 'Other Current Asset' AND ros.account_number LIKE '13%')
        OR (mapping.source_type = 'category_cogs' AND ros.account_type = 'Cost of Goods Sold' AND ros.account_number LIKE '53%')
      )
)
UPDATE qbo_mappings AS mapping
SET ros_gl_account_number = candidate.account_number,
    updated_at = CURRENT_TIMESTAMP
FROM category_candidates AS candidate
WHERE mapping.id = candidate.mapping_id
  AND candidate.preference = 1;

UPDATE ledger_mappings
SET ros_gl_account_number = CASE internal_key
        WHEN 'REVENUE_CLOTHING' THEN '4200'
        WHEN 'REVENUE_FOOTWEAR' THEN '4271'
        WHEN 'REVENUE_SERVICE' THEN '4100'
        WHEN 'REVENUE_ALTERATIONS' THEN '4296'
        WHEN 'REVENUE_SHIPPING' THEN '4295'
        WHEN 'REVENUE_INVENTORY_ADJUSTMENT' THEN '5399'
        WHEN 'INV_ASSET' THEN '1300'
        WHEN 'INV_SHRINKAGE' THEN '5410'
        WHEN 'COGS_DEFAULT' THEN '5300'
        WHEN 'COGS_FREIGHT' THEN '5395-1'
        WHEN 'EXP_SHIPPING' THEN '5395-3'
        WHEN 'EXP_MERCHANT_FEE' THEN '6240'
        WHEN 'CASH_ROUNDING' THEN '4999'
        WHEN 'RMS_CHARGE_FINANCING_CLEARING' THEN '1210-0'
        WHEN 'RMS_R2S_PAYMENT_CLEARING' THEN '1210-0'
        WHEN 'REFUND_LIABILITY_CLEARING' THEN '2001'
        ELSE ros_gl_account_number
    END,
    updated_at = CURRENT_TIMESTAMP
WHERE ros_gl_account_number IS NULL;

COMMENT ON COLUMN qbo_mappings.source_type IS
  'category_revenue | category_inventory | category_cogs | custom_revenue | custom_inventory | custom_cogs | tender | tax | liability_deposit | liability_gift_card | liability_store_credit | liability_refund_queue | expense_loyalty | expense_donated | expense_merchant_fee | clearing_invoice_holding | expense_shipping | income_forfeited_deposit | income_shipping | income_alterations | income_gift_card_breakage';
