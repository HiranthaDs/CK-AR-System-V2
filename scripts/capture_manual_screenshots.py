"""Capture CK SYS V3 documentation screenshots with isolated sample API data.

Run the Vite frontend on http://127.0.0.1:5173, then execute this script with
backend/.venv/Scripts/python. No production records or credentials are used.
"""

from __future__ import annotations

import base64
import json
import time
from pathlib import Path

from playwright.sync_api import Page, Route, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "docs" / "screenshots" / "user-manual"
BASE_URL = "http://127.0.0.1:5173"
COMPANY_ID = "11111111-1111-4111-8111-111111111111"
USER_ID = "22222222-2222-4222-8222-222222222222"


def jwt() -> str:
    header = {"alg": "none", "typ": "JWT"}
    payload = {
        "aud": "authenticated",
        "exp": int(time.time()) + 86_400,
        "iat": int(time.time()),
        "iss": "https://khtmogtjyjpekftzkfcr.supabase.co/auth/v1",
        "role": "authenticated",
        "sub": USER_ID,
        "email": "manual.demo@example.com",
    }

    def encode(value: dict[str, object]) -> str:
        raw = json.dumps(value, separators=(",", ":")).encode()
        return base64.urlsafe_b64encode(raw).decode().rstrip("=")

    return f"{encode(header)}.{encode(payload)}.documentation"


def page_payload(items: list[dict[str, object]] | None = None) -> dict[str, object]:
    rows = items or []
    return {
        "items": rows,
        "total": len(rows),
        "page": 1,
        "page_size": 100,
        "pages": 1 if rows else 0,
        "next_cursor": None,
    }


ME = {
    "user_id": USER_ID,
    "email": "manual.demo@example.com",
    "display_name": "Manual Demo",
    "is_active": True,
    "active_company_id": COMPANY_ID,
    "active_company_code": "CK",
    "active_company_name": "CK Plastics",
    "is_super_admin": True,
    "role_codes": ["admin"],
    "permission_codes": ["system.admin"],
    "companies": [
        {
            "company_id": COMPANY_ID,
            "code": "CK",
            "name": "CK Plastics",
            "is_primary": True,
            "role_codes": ["admin"],
            "permission_codes": ["system.admin"],
        }
    ],
}

DASHBOARD = {
    "year": 2026,
    "inventory": {
        "bulk": [{"quantity_on_hand": 2450, "inventory_value": 1_715_000, "item_count": 3}],
        "chip": [{"quantity_on_hand": 920, "inventory_value": 828_000, "item_count": 4}],
        "finished": [{"quantity_on_hand": 12_480, "inventory_value": 2_184_000, "item_count": 8}],
    },
    "finance": {
        "revenue": 8_460_000,
        "cogs": 5_170_000,
        "expenses": 1_120_000,
        "receivables": 684_500,
        "payables": 392_000,
        "cash_bank": 1_936_400,
    },
    "workforce": {"active_employees": 24, "open_daily_wages": 86_500, "open_piecework": 42_750},
    "operations": {"purchases": 34, "conversions": 48, "production": 126, "sales": 204, "payroll": 22},
    "generated_at": "2026-10-24T12:30:00Z",
}

PRODUCTION_SUMMARY = {
    "as_of": "2026-10-24",
    "month": "2026-10",
    "today_runs": 6,
    "today_input_kg": 210,
    "today_output_quantity": 3250,
    "month_runs": 126,
    "month_input_kg": 4120,
    "month_output_quantity": 64_300,
    "bulk_item_count": 3,
    "chip_item_count": 4,
    "bulk_value": 1_715_000,
    "chip_value": 828_000,
    "recent_daily": [
        {"production_date": "2026-10-20", "run_count": 4, "input_kg": 180, "output_quantity": 2800, "total_cost": 462000},
        {"production_date": "2026-10-21", "run_count": 5, "input_kg": 195, "output_quantity": 3020, "total_cost": 498000},
        {"production_date": "2026-10-22", "run_count": 5, "input_kg": 205, "output_quantity": 3180, "total_cost": 520000},
        {"production_date": "2026-10-23", "run_count": 6, "input_kg": 215, "output_quantity": 3310, "total_cost": 541000},
        {"production_date": "2026-10-24", "run_count": 6, "input_kg": 210, "output_quantity": 3250, "total_cost": 533000},
    ],
}

INVENTORY_ITEMS = [
    {
        "item_id": "33333333-3333-4333-8333-333333333331",
        "sku": "FP-001",
        "item_name": "5 Litre Utility Bucket",
        "stage": "finished",
        "unit": "piece",
        "quantity_on_hand": 6480,
        "shared_quantity_on_hand": 9250,
        "inventory_value": 1_134_000,
        "average_unit_cost": 175,
        "selling_price": 295,
        "last_movement_at": "2026-10-24T08:15:00Z",
        "is_active": True,
    },
    {
        "item_id": "33333333-3333-4333-8333-333333333332",
        "sku": "FP-002",
        "item_name": "10 Litre Storage Container",
        "stage": "finished",
        "unit": "piece",
        "quantity_on_hand": 6000,
        "shared_quantity_on_hand": 8100,
        "inventory_value": 1_050_000,
        "average_unit_cost": 175,
        "selling_price": 340,
        "last_movement_at": "2026-10-24T09:05:00Z",
        "is_active": True,
    },
]

INVENTORY_SUMMARY = {
    "bulk": {"item_count": 3, "total_quantity": 2450, "shared_total_quantity": 3100, "total_value": 1_715_000},
    "chips": {"item_count": 4, "total_quantity": 920, "shared_total_quantity": 1380, "total_value": 828_000},
    "finished": {"item_count": 8, "total_quantity": 12_480, "shared_total_quantity": 17_350, "total_value": 2_184_000},
    "total_quantity": 15_850,
    "shared_total_quantity": 21_830,
    "total_value": 4_727_000,
}

ACCOUNT_BALANCES = [
    {"account_id": 1, "account_code": "CASH", "account_name": "Cash on hand", "category": "asset", "debit_total": 1_250_000, "credit_total": 100_000, "balance": 1_150_000},
    {"account_id": 2, "account_code": "BANK", "account_name": "Bank current account", "category": "asset", "debit_total": 1_000_000, "credit_total": 213_600, "balance": 786_400},
    {"account_id": 3, "account_code": "AR", "account_name": "Trade receivables", "category": "asset", "debit_total": 684_500, "credit_total": 0, "balance": 684_500, "is_control_account": True},
    {"account_id": 4, "account_code": "AP", "account_name": "Trade payables", "category": "liability", "debit_total": 0, "credit_total": 392_000, "balance": 392_000, "is_control_account": True},
    {"account_id": 5, "account_code": "CAPITAL", "account_name": "Owner capital", "category": "equity", "debit_total": 0, "credit_total": 543_900, "balance": 543_900},
    {"account_id": 6, "account_code": "SALES", "account_name": "Sales revenue", "category": "revenue", "debit_total": 0, "credit_total": 8_460_000, "balance": 8_460_000, "is_control_account": True},
    {"account_id": 7, "account_code": "COGS", "account_name": "Cost of goods sold", "category": "expense", "debit_total": 5_170_000, "credit_total": 0, "balance": 5_170_000, "is_control_account": True},
    {"account_id": 8, "account_code": "UTIL", "account_name": "Utilities expense", "category": "expense", "debit_total": 1_120_000, "credit_total": 0, "balance": 1_120_000},
    {"account_id": 9, "account_code": "OFFSET", "account_name": "Opening balance offset", "category": "equity", "debit_total": 0, "credit_total": 8_118_600, "balance": 8_118_600},
]

AUDIT_ROWS = [
    {
        "id": 101,
        "occurred_at": "2026-10-24T09:42:00Z",
        "actor_user_id": USER_ID,
        "actor_display_name": "Manual Demo",
        "actor_email": "manual.demo@example.com",
        "operation": "post_sales_invoice",
        "entity_table": "sales",
        "entity_id": "INV-2026-0204",
        "action": "insert",
        "before_data": None,
        "after_data": {"invoice_no": "INV-2026-0204", "total_amount": 144250},
        "request_id": "req-demo-001",
        "company_id": COMPANY_ID,
    },
    {
        "id": 100,
        "occurred_at": "2026-10-24T08:18:00Z",
        "actor_user_id": USER_ID,
        "actor_display_name": "Manual Demo",
        "actor_email": "manual.demo@example.com",
        "operation": "post_production_run",
        "entity_table": "production_runs",
        "entity_id": "PR-2026-0126",
        "action": "insert",
        "before_data": None,
        "after_data": {"output_quantity": 3250},
        "request_id": "req-demo-002",
        "company_id": COMPANY_ID,
    },
]

ADMIN_USERS = [
    {
        "company_id": COMPANY_ID,
        "company_code": "CK",
        "company_name": "CK Plastics",
        "user_id": USER_ID,
        "display_name": "Manual Demo",
        "email": "manual.demo@example.com",
        "profile_active": True,
        "is_super_admin": True,
        "membership_active": True,
        "is_primary": True,
        "role_codes": ["admin"],
    },
    {
        "company_id": COMPANY_ID,
        "company_code": "CK",
        "company_name": "CK Plastics",
        "user_id": "22222222-2222-4222-8222-222222222223",
        "display_name": "Production Operator",
        "email": "operator@example.com",
        "profile_active": True,
        "is_super_admin": False,
        "membership_active": True,
        "is_primary": True,
        "role_codes": ["production_operations"],
    },
]


def api_response(path: str) -> dict[str, object]:
    if path == "/api/v1/me":
        return ME
    if path == "/api/v1/dashboard":
        return DASHBOARD
    if path == "/api/v1/production/summary":
        return PRODUCTION_SUMMARY
    if path == "/api/v1/inventory/summary":
        return INVENTORY_SUMMARY
    if path.startswith("/api/v1/inventory/finished") or path.startswith("/api/v1/reports/inventory"):
        return page_payload(INVENTORY_ITEMS)
    if path == "/api/v1/account-balances":
        return page_payload(ACCOUNT_BALANCES)
    if path == "/api/v1/reports/audit-log":
        return page_payload(AUDIT_ROWS)
    if path == "/api/v1/admin/users":
        return page_payload(ADMIN_USERS)
    if path == "/api/v1/conversion-types":
        return page_payload([
            {"id": "44444444-4444-4444-8444-444444444441", "name": "Clear PP", "default_chip_name": "Clear PP Chip", "notes": "Standard clear material", "status": "active"},
            {"id": "44444444-4444-4444-8444-444444444442", "name": "Colour Mix", "default_chip_name": "Mixed Colour Chip", "notes": "Sorted colour material", "status": "active"},
        ])
    if path == "/api/v1/piecework-rates":
        return page_payload([
            {"id": "55555555-5555-4555-8555-555555555551", "conversion_type_id": "44444444-4444-4444-8444-444444444441", "work_type": "Sorting and grinding", "rate_per_kg": 18.5, "effective_from": "2026-01-01", "effective_to": None, "status": "active"},
            {"id": "55555555-5555-4555-8555-555555555552", "conversion_type_id": "44444444-4444-4444-8444-444444444442", "work_type": "Washing and grinding", "rate_per_kg": 22, "effective_from": "2026-01-01", "effective_to": None, "status": "active"},
        ])
    if path == "/api/v1/reports/financial-summary":
        return {
            "generated_at": "2026-10-24T12:30:00Z",
            "filters": {"year": 2026},
            "totals": {"revenue": 8_460_000, "cogs": 5_170_000, "expenses": 1_120_000, "net_result": 2_170_000, "assets": 4_727_000, "liabilities": 392_000, "equity": 4_335_000},
            "items": [],
        }
    return page_payload()


def route_api(route: Route) -> None:
    request_path = route.request.url.split("?", 1)[0]
    marker = request_path.find("/api/v1/")
    path = request_path[marker:] if marker >= 0 else request_path
    route.fulfill(status=200, content_type="application/json", body=json.dumps(api_response(path)))


def save(page: Page, filename: str) -> None:
    try:
        page.locator("main#main-content").wait_for(state="visible", timeout=15_000)
    except Exception:
        print(f"Screenshot wait failed at {page.url}: {page.locator('body').inner_text()[:500]}")
        raise
    page.wait_for_timeout(400)
    page.screenshot(path=str(OUTPUT / filename), full_page=True)


def open_page(page: Page, path: str, filename: str) -> None:
    page.goto(f"{BASE_URL}{path}", wait_until="networkidle")
    save(page, filename)


def select_tab(page: Page, label: str, filename: str) -> None:
    page.get_by_role("tab", name=label, exact=True).click()
    page.wait_for_timeout(500)
    save(page, filename)


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    browser_path = Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")
    if not browser_path.exists():
        browser_path = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, executable_path=str(browser_path))

        public = browser.new_context(viewport={"width": 1440, "height": 1050}, device_scale_factor=1)
        public_page = public.new_page()
        public_page.goto(f"{BASE_URL}/login", wait_until="networkidle")
        public_page.screenshot(path=str(OUTPUT / "01-company-portal-selection.png"), full_page=True)
        public_page.goto(f"{BASE_URL}/ck/login", wait_until="networkidle")
        public_page.screenshot(path=str(OUTPUT / "02-ck-sign-in.png"), full_page=True)
        public_page.get_by_role("button", name="Forgot your password?").click()
        public_page.screenshot(path=str(OUTPUT / "03-password-recovery.png"), full_page=True)
        public.close()

        authenticated = browser.new_context(viewport={"width": 1440, "height": 1050}, device_scale_factor=1)
        authenticated.route("**/api/v1/**", route_api)
        authenticated.route("**/auth/v1/**", lambda route: route.fulfill(status=200, content_type="application/json", body="{}"))
        token = jwt()
        session = {
            "access_token": token,
            "refresh_token": "documentation-refresh-token",
            "expires_at": int(time.time()) + 86_400,
            "expires_in": 86_400,
            "token_type": "bearer",
            "user": {
                "id": USER_ID,
                "aud": "authenticated",
                "role": "authenticated",
                "email": "manual.demo@example.com",
                "email_confirmed_at": "2026-01-01T00:00:00Z",
                "app_metadata": {"provider": "email", "providers": ["email"]},
                "user_metadata": {"display_name": "Manual Demo"},
                "created_at": "2026-01-01T00:00:00Z",
            },
        }
        storage_key = json.dumps("ck-sys-v3-auth")
        storage_value = json.dumps(json.dumps(session))
        authenticated.add_init_script(
            f"localStorage.setItem({storage_key}, {storage_value})"
        )
        page = authenticated.new_page()

        open_page(page, "/ck/dashboard", "04-dashboard.png")
        open_page(page, "/ck/production", "05-production-dashboard.png")
        select_tab(page, "Bulk RM", "06-production-bulk-rm.png")
        page.get_by_role("button", name="New purchase").click()
        page.screenshot(path=str(OUTPUT / "07-post-purchase-dialog.png"), full_page=True)
        page.get_by_role("button", name="Cancel").click()
        select_tab(page, "Conversions", "08-production-conversions.png")
        select_tab(page, "Production runs", "09-production-runs.png")

        open_page(page, "/ck/inventory", "10-inventory-finished.png")
        select_tab(page, "Read-only report", "11-inventory-report.png")

        open_page(page, "/ck/sales", "12-sales-invoices.png")
        page.get_by_role("button", name="New invoice").first.click()
        page.screenshot(path=str(OUTPUT / "13-new-invoice-dialog.png"), full_page=True)
        page.get_by_role("button", name="Cancel").click()
        select_tab(page, "Outstanding", "14-sales-outstanding.png")

        open_page(page, "/ck/employees", "15-staff-employees.png")
        select_tab(page, "Daily work", "16-staff-daily-work.png")
        select_tab(page, "OT hours", "17-staff-overtime.png")
        select_tab(page, "Open earnings", "18-staff-open-earnings.png")
        select_tab(page, "Payroll", "19-staff-payroll.png")
        select_tab(page, "Payroll report", "20-staff-payroll-report.png")

        open_page(page, "/ck/accounting", "21-accounting-overview.png")
        select_tab(page, "Quick entry", "22-accounting-quick-entry.png")
        select_tab(page, "Journals", "23-accounting-journals.png")
        select_tab(page, "Master ledger", "24-accounting-ledger.png")
        select_tab(page, "Statements", "25-accounting-statements.png")

        open_page(page, "/ck/activity", "26-activity-audit.png")
        open_page(page, "/ck/account", "27-account-security.png")
        open_page(page, "/ck/settings", "28-settings.png")
        page.get_by_role("button", name="Create account").click()
        page.screenshot(path=str(OUTPUT / "29-create-account-dialog.png"), full_page=True)

        authenticated.close()
        browser.close()

    print(f"Captured {len(list(OUTPUT.glob('*.png')))} screenshots in {OUTPUT}")


if __name__ == "__main__":
    main()
