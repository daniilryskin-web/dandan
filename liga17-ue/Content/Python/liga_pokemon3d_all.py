"""Лига 17 — imports every available 3D Pokémon model (about 1 GB, can take an hour or more).
Run with Tools → Execute Python Script…; already imported models are skipped, so it can be stopped and resumed."""
import importlib

import liga_pokemon3d

importlib.reload(liga_pokemon3d)
liga_pokemon3d.import_all()
