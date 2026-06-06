import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ozon_parser import (  # noqa: E402
    _extract_search_items,
    _normalize_search_item,
    extract_documents_from_widgets,
    parse_widget_states,
)


def test_normalize_search_item_extracts_sku_from_product_url():
    item = {
        "title": "Тестовый товар",
        "action": {"link": "/product/testovyy-tovar-123456789/"},
        "finalPrice": "1 299 ₽",
    }

    parsed = _normalize_search_item(item)

    assert parsed is not None
    assert parsed["sku"] == "123456789"
    assert parsed["url"] == "https://www.ozon.ru/product/testovyy-tovar-123456789/"
    assert parsed["finalPrice"] == 1299.0


def test_extract_search_items_recursively_handles_new_widget_shape():
    widget = {
        "payload": {
            "tiles": [
                {
                    "card": {
                        "title": "Смартфон Example",
                        "action": {"link": "/product/smartfon-example-987654321/"},
                    }
                }
            ]
        }
    }

    items = _extract_search_items(widget)

    assert len(items) == 1
    assert items[0]["sku"] == "987654321"
    assert items[0]["title"] == "Смартфон Example"


def test_parse_widget_states_keeps_raw_widgets_for_document_fallback():
    registry_url = "https://pub.fsa.gov.ru/rss/certificate/view/2406631/baseInfo"
    states = {
        "webProductHeading-123-default-1": json.dumps({"title": "Товар"}, ensure_ascii=False),
        "unknownCertificateWidget-1": json.dumps({"href": registry_url}, ensure_ascii=False),
    }

    card = parse_widget_states(states)
    docs = extract_documents_from_widgets(card.raw_widget_states)

    assert card.product_name == "Товар"
    assert card.raw_widget_states == states
    assert docs and docs[0]["url"] == registry_url
