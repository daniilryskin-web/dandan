import asyncio

from ozon_parser import OzonClient, _extract_search_items_deep


def test_ozon_search_path_keeps_raw_cyrillic(monkeypatch):
    seen = {}

    async def fake_fetch_json(self, url_path):
        seen["url_path"] = url_path
        return {"widgetStates": {}}

    monkeypatch.setattr(OzonClient, "fetch_json", fake_fetch_json)

    async def run():
        client = OzonClient(workers=1)
        items, next_page = await client.search("детская обувь", page=2)
        assert items == []
        assert next_page is None

    asyncio.run(run())
    assert seen["url_path"] == "/search/?text=детская обувь&page=2"
    assert "%25" not in seen["url_path"]


def test_ozon_deep_search_extractor_finds_nested_product_links():
    payload = {
        "widgetStates": {
            "renamedWidget-123": {
                "payload": {
                    "cards": [
                        {
                            "action": {"link": "/product/krossovki-testovye-123456789/"},
                            "title": "Кроссовки тестовые",
                            "price": "1 999 ₽",
                        },
                        {
                            "href": "https://www.ozon.ru/product/botinki-987654321/?from=search",
                            "name": "Ботинки",
                            "finalPrice": "2 499 ₽",
                        },
                    ]
                }
            }
        }
    }

    items = _extract_search_items_deep(payload)
    assert [item["sku"] for item in items[:2]] == ["123456789", "987654321"]
    assert items[0]["url"] == "https://www.ozon.ru/product/krossovki-testovye-123456789/"
    assert items[0]["title"] == "Кроссовки тестовые"
