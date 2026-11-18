from datetime import date
from decimal import Decimal
from uuid import uuid4

import pytest
from pydantic import ValidationError

from app.models import ProductUpsert, PublicOrderCreate, QuotationUpsert


def test_product_requires_positive_selling_price() -> None:
    with pytest.raises(ValidationError):
        ProductUpsert(name="Frame", product_type="Photo frame", selling_price=Decimal("0"))


def test_product_accepts_catalogue_presentation_fields() -> None:
    product = ProductUpsert(
        name="Classic frame stand",
        product_type="Frame Stand",
        selling_price=Decimal("1250.00"),
        image_url="https://example.supabase.co/storage/v1/object/public/product-images/frame.webp",
        description="A stable display stand for standard photo frames.",
    )

    assert product.product_type == "Frame Stand"
    assert product.selling_price == Decimal("1250.00")
    assert product.image_url is not None


def test_product_rejects_non_https_image_url() -> None:
    with pytest.raises(ValidationError):
        ProductUpsert(
            name="Head clip",
            product_type="Head Clip",
            selling_price=Decimal("250"),
            image_url="http://insecure.example/head-clip.png",
        )


def test_public_order_rejects_duplicate_products() -> None:
    item_id = uuid4()
    with pytest.raises(ValidationError, match="unique"):
        PublicOrderCreate(
            customer_name="Customer",
            customer_phone="+94 77 123 4567",
            items=[
                {"item_id": item_id, "quantity": 1},
                {"item_id": item_id, "quantity": 2},
            ],
        )


def test_public_order_honeypot_rejects_bots() -> None:
    with pytest.raises(ValidationError, match="could not be submitted"):
        PublicOrderCreate(
            customer_name="Customer",
            customer_phone="+94 77 123 4567",
            website="https://spam.invalid",
            items=[{"item_id": uuid4(), "quantity": 1}],
        )


def test_quotation_rejects_invalid_validity_period() -> None:
    with pytest.raises(ValidationError):
        QuotationUpsert(
            quotation_date=date(2026, 11, 18),
            valid_until=date(2026, 11, 17),
            customer_name="Customer",
            items=[{"item_id": uuid4(), "quantity": 1, "unit_price": 500, "discount": 0}],
        )


def test_quotation_rejects_duplicate_products() -> None:
    item_id = uuid4()
    with pytest.raises(ValidationError):
        QuotationUpsert(
            quotation_date=date(2026, 11, 18),
            valid_until=date(2026, 12, 2),
            customer_name="Customer",
            items=[
                {"item_id": item_id, "quantity": 1, "unit_price": 500, "discount": 0},
                {"item_id": item_id, "quantity": 2, "unit_price": 500, "discount": 0},
            ],
        )
