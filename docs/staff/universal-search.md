# Universal Search

**Audience:** All staff.

**Where in ROS:** Top Bar in Back Office and POS.

**Related permissions:** Universal Search reflects what you can already open. If a result exists but opening it fails, the issue is usually permissions on that workspace or record, not the search tool itself.

---

## What Universal Search is for

Universal Search is the fastest way to **jump to the right record** when you know **what** you want but not **where Riverside keeps it**.

Use it when you know a:

- customer name, phone, email, or customer code
- SKU or product name
- transaction number
- shipment or tracking value
- wedding party name
- alteration customer or ticket details

Universal Search is a **jump tool**, not a full reporting screen. It helps you get to the correct workspace quickly.

## How to open it

- Click the **Search** trigger in the Top Bar.
- Keyboard: press **Cmd/Ctrl + K**.
- Keyboard: press **/** when you are not typing in another field.

In POS, the trigger is intentionally tighter so it does not crowd the header. The search overlay is still the same once opened.

## How to use this screen

1. Open **Universal Search** from the Top Bar.
2. Type at least **2 characters** for most searches.
3. Review the grouped results.
4. Press **Enter** to open the highlighted result.
5. Use **Arrow Up** / **Arrow Down** to change the highlighted result.
6. For some customer flows, **Alt+Enter** sends the customer to the register instead of opening the customer drawer.

## What kinds of results you may see

| Result type | What it helps with |
|------------|--------------------|
| **Customer** | Jump to the customer profile or send the customer into POS |
| **Exact SKU** | Open the matching inventory/product target quickly |
| **Product** | Find the right item when you know the product or variation |
| **Transaction** | Open the matching transaction/order record |
| **Shipment** | Jump to shipping details or tracking context |
| **Wedding** | Open the wedding party |
| **Alteration** | Jump to the alteration record |

## Common tasks

### Open a customer when you do not remember the workspace

1. Open **Universal Search**.
2. Type the customer name, phone, email, or customer code.
3. Choose the matching **Customer** result.
4. ROS opens the correct customer destination for your current shell.

### Jump to a product or SKU quickly

1. Open **Universal Search**.
2. Type the SKU if you know it exactly, or part of the product name if you do not.
3. Choose the **Exact SKU** or **Product** result.
4. ROS opens the related inventory/product destination.

### Jump to a wedding party, shipment, or alteration

1. Open **Universal Search**.
2. Type the party name, tracking value, customer name, or other identifying detail.
3. Select the matching result group.
4. ROS takes you to the related workspace.

## Closing the search

- Press **Esc**
- Click the **Esc Close** button
- Click outside the search panel

## Common issues and fixes

| Problem | What to try first | If that fails |
|--------|-------------------|---------------|
| No results | Use a broader search term; check spelling; try 2+ characters | Search from the destination workspace directly |
| Exact customer or SKU not found | Try phone, email, customer code, or partial SKU/name | Confirm the record exists and is active |
| Search opens the wrong kind of result | Read the result group label before pressing Enter | Use arrow keys to highlight the correct row |
| Result exists but will not open | You may not have permission for that workspace | Ask a manager or switch to an authorized staff member |
| Keyboard shortcut does nothing | Click the Search trigger manually first | Refresh once; if still broken, submit a bug report |

## When to use Universal Search vs normal workspace search

- Use **Universal Search** when you know the entity but not the module.
- Use the **workspace’s own search** when you are already in the right area and want filters, lists, or deeper browsing.

Examples:

- “I know the customer, not whether I need Customers, POS, or Weddings.” → **Universal Search**
- “I am already in Inventory and need a filtered working list.” → **Inventory search**
- “I am already in Transactions and need history review.” → **Transactions search**

## When to get a manager

- A result consistently opens the wrong record
- A result should exist but never appears for multiple staff
- You get repeated permission or server errors after refresh

## See also

- [00-getting-started.md](00-getting-started.md)
- [FAQ.md](FAQ.md)
- [customers-back-office.md](customers-back-office.md)
- [pos-register-cart.md](pos-register-cart.md)
- [inventory-back-office.md](inventory-back-office.md)
- [pos-inventory.md](pos-inventory.md)

**Last reviewed:** 2026-04-24
