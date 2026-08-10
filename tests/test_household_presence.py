from custom_components.home_status.engine import HomeStatusEngine


def test_household_presence_groups_selected_people_and_hides_individual_items(hass):
    hass.states.async_set("person.alex", "home", {"friendly_name": "Alex"})
    hass.states.async_set("person.blair", "home", {"friendly_name": "Blair"})

    items = HomeStatusEngine(hass).build_awareness_items({
        "household_presence_enabled": True,
        "household_presence_people": ["person.alex", "person.blair"],
        "selected_sources": ["source:person.alex", "source:person.blair"],
    })

    assert len(items) == 1
    assert items[0]["id"] == "home_status:household_presence:awareness"
    assert items[0]["title"] == "Everyone Home"
    assert items[0]["summary"] == "Alex, Blair"


def test_household_presence_reports_a_mixed_household(hass):
    hass.states.async_set("person.alex", "home", {"friendly_name": "Alex"})
    hass.states.async_set("person.blair", "work", {"friendly_name": "Blair"})

    items = HomeStatusEngine(hass).build_awareness_items({
        "household_presence_enabled": True,
        "household_presence_people": ["person.alex", "person.blair"],
    })

    assert items[0]["title"] == "1 of 2 Home"
    assert items[0]["summary"] == "Alex home · Blair away"
