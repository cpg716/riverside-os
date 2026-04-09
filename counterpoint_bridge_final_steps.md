# 🏁 Counterpoint Bridge: Final Completion Checklist

We have successfully mapped your **Catalog (3D Matrix)**, **Customers**, **Ticket History**, and **Open Orders (Layaways)**. To complete the 100% "Gold Master" sync, we just need to map your custom Gift Card and Loyalty tables.

---

### 1. Run the Final Schema Probe (SSMS)
Paste the following code into a **New Query** window in SQL Server Management Studio (SSMS) against your company database. 

```sql
SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE 
FROM INFORMATION_SCHEMA.COLUMNS 
WHERE TABLE_NAME IN ('SY_GFC', 'SY_GFC_HIST', 'AR_LOY_PT_ADJ_HIST')
ORDER BY TABLE_NAME, COLUMN_NAME;
```

### 2. Provide the Results
Copy the grid results (or take a screenshot/save to text) and provide them here. I am specifically looking for:
- The **Balance** and **Gift Card Number** column names in `SY_GFC`.
- The **Points Earned/Adjusted** column names in `AR_LOY_PT_ADJ_HIST`.

### 3. The Final Build (My Task)
Once you provide those columns, I will:
- Update the `.env.example` with perfect column mappings for all modules.
- Disable the broken Store Credit columns (`SYNC_STORE_CREDIT_OPENING=0`).
- Re-package the **Final Windows Bridge Zip**.

### 4. Deployment on Windows Server
- Copy the new `counterpoint-bridge-for-windows.zip` to the server.
- Update the `.env` with your SQL password and Riverside API Key.
- Double-click `START_BRIDGE.cmd` to initiate the full data migration.

---

> [!TIP]
> Once this sync completes, Riverside OS will have a mirror image of your Counterpoint data, allowing you to begin processing transactions and managing your wedding parties immediately.
