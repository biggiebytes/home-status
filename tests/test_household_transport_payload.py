from __future__ import annotations

import ast
import json
import unittest
from pathlib import Path
from types import SimpleNamespace
from typing import Any


PROJECT = Path(__file__).resolve().parents[1]


def _load_function(path: Path, function_name: str, namespace: dict[str, Any]):
    tree = ast.parse(path.read_text(encoding="utf-8"))
    function = next(
        node for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        and node.name == function_name
    )
    module = ast.Module(body=[function], type_ignores=[])
    exec(compile(ast.fix_missing_locations(module), str(path), "exec"), namespace)
    return namespace[function_name]


def _load_method(path: Path, class_name: str, method_name: str, namespace: dict[str, Any]):
    tree = ast.parse(path.read_text(encoding="utf-8"))
    owner = next(
        node for node in tree.body
        if isinstance(node, ast.ClassDef) and node.name == class_name
    )
    method = next(
        node for node in owner.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        and node.name == method_name
    )
    method.decorator_list = []
    module = ast.Module(body=[method], type_ignores=[])
    exec(compile(ast.fix_missing_locations(module), str(path), "exec"), namespace)
    return namespace[method_name]


def _load_sensor_payload_class():
    path = PROJECT / "custom_components/home_status/sensor.py"
    tree = ast.parse(path.read_text(encoding="utf-8"))
    original = next(
        node for node in tree.body
        if isinstance(node, ast.ClassDef)
        and node.name == "HomeStatusTransportSensor"
    )
    names = {"_items", "_compact_items", "_fit_budget", "extra_state_attributes"}
    methods = [
        node for node in original.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        and node.name in names
    ]
    cls = ast.ClassDef(
        name="PayloadSensor",
        bases=[],
        keywords=[],
        body=methods,
        decorator_list=[],
    )
    module = ast.Module(body=[cls], type_ignores=[])
    namespace: dict[str, Any] = {
        "Any": Any,
        "json": json,
        "TRANSPORT_VERSION": 1,
    }
    exec(compile(ast.fix_missing_locations(module), str(path), "exec"), namespace)
    return namespace["PayloadSensor"]


class HouseholdTransportPayloadTest(unittest.TestCase):
    def test_mixed_household_record_survives_transport_budget(self):
        people = {
            "person.alex": SimpleNamespace(
                entity_id="person.alex",
                state="home",
                attributes={"friendly_name": "Alex"},
                last_changed=None,
            ),
            "person.jordan": SimpleNamespace(
                entity_id="person.jordan",
                state="not_home",
                attributes={"friendly_name": "Jordan"},
                last_changed=None,
            ),
        }
        hass = SimpleNamespace(
            states=SimpleNamespace(get=lambda entity_id: people.get(entity_id))
        )
        interpreters = PROJECT / "custom_components/home_status/source_interpreters.py"
        household_presence_item = _load_function(
            interpreters,
            "household_presence_item",
            {"Any": Any, "HomeAssistant": object, "_now": lambda: "now"},
        )
        filler = [
            {
                "id": f"location-{index}",
                "title": f"Location awareness {index}",
                "summary": "x" * 520,
                "category": "location",
                "source_kind": "location",
                "source": "selected_location_source",
                "priority": "normal",
                "active": False,
            }
            for index in range(30)
        ]
        engine_path = PROJECT / "custom_components/home_status/engine.py"
        engine_globals = {
            "Any": Any,
            "household_presence_item": household_presence_item,
            "awareness_entity": lambda *_args: [],
            "interpret_source": lambda *_args: filler,
        }

        class EngineHarness:
            def selected_entities(self, _options):
                return []

            def selected_home_devices(self, _options):
                return []

            def _selected_entity_ids(self, _options):
                return []

            def selected_sources(self, _options):
                return [SimpleNamespace(domain="sensor", entity_id="sensor.location")]

        EngineHarness.hass = hass
        EngineHarness._household_person_ids = _load_method(
            engine_path, "HomeStatusEngine", "_household_person_ids", engine_globals
        )
        EngineHarness._dedupe = staticmethod(
            _load_method(engine_path, "HomeStatusEngine", "_dedupe", engine_globals)
        )
        EngineHarness.build_awareness_items = _load_method(
            engine_path, "HomeStatusEngine", "build_awareness_items", engine_globals
        )
        options = {
            "household_presence_enabled": True,
            "household_presence_people": ["person.alex", "person.jordan"],
        }
        awareness = EngineHarness().build_awareness_items(options)
        household = awareness[-1]
        self.assertEqual(household["title"], "1 of 2 Home")
        self.assertEqual(household["detail"], "Alex home · Jordan away")

        native = PROJECT / "custom_components/home_status/ha_native.py"
        present_awareness_items = _load_function(
            native,
            "present_awareness_items",
            {
                "Any": Any,
                "_final_category": lambda value: value,
                "_final_title": lambda item: item.get("title") or item.get("message") or "",
                "_awareness_color_role": lambda *_args: "presence",
                "_option_bool": lambda _options, _key, default=False: default,
                "_MEASUREMENT_DEVICE_CLASSES": set(),
            },
        )
        # The coordinator passes engine awareness through native presentation
        # and stores it as native.awareness before the sensor builds its channel.
        awareness = present_awareness_items(awareness, {})
        transport = _load_sensor_payload_class()
        sensor = transport.__new__(transport)
        sensor._channel = "household"
        data = {
            "snapshot_revision": 7,
            "native": {"awareness": awareness},
        }
        sensor.coordinator = SimpleNamespace(data=data)

        selected = sensor._items(data)
        self.assertEqual(selected[-1]["source"], "household_presence")
        before_trim = {
            "version": 1,
            "kind": "channel",
            "channel": "household",
            "revision": 7,
            "items": sensor._compact_items(selected),
        }
        before_trim_size = len(
            json.dumps(before_trim, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        )
        # Call the real transport entity property; this is the exact attribute
        # payload published by sensor.home_status_household.
        payload = sensor.extra_state_attributes["transport"]
        after_trim = len(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        )

        self.assertGreater(before_trim_size, 12_000)
        self.assertLessEqual(after_trim, 12_000)
        household_items = [
            item for item in payload["items"]
            if item.get("source") == "household_presence"
        ]
        self.assertEqual(len(household_items), 1)
        self.assertEqual(household_items[0]["title"], "1 of 2 Home")
        self.assertEqual(household_items[0]["summary"], "Alex home · Jordan away")


if __name__ == "__main__":
    unittest.main()
