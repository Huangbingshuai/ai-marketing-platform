"""Independently versioned creative strategies; no provider or task state here."""
from types import ModuleType
from . import ecommerce, local_store, brand_ad, drama, brand_ad_v1, brand_ad_v3, drama_v3, brand_ad_v7, drama_v7, brand_ad_v11, drama_v11, brand_ad_v14, brand_ad_v14_2, brand_ad_v14_3, brand_ad_v14_5, brand_ad_v14_6, brand_ad_v14_7

VERSION = "2026-10-14.7"
STRATEGIES = {"ECOMMERCE": ecommerce, "LOCAL_STORE": local_store, "BRAND_AD": brand_ad_v14_7, "DRAMA": drama_v11}


def strategy_for(route: str, version: str) -> ModuleType:
    if route == 'BRAND_AD' and version == '2026-10-14.6':
        return brand_ad_v14_6
    if route == 'BRAND_AD' and version == '2026-10-14.5':
        return brand_ad_v14_5
    if route == 'BRAND_AD' and version in {'2026-10-14.3', '2026-10-14.4'}:
        return brand_ad_v14_3
    if route == 'BRAND_AD' and version == '2026-10-14.2':
        return brand_ad_v14_2
    if route == 'BRAND_AD' and version == '2026-10-14.1':
        return brand_ad_v14
    if route == 'BRAND_AD' and version == '2026-10-13.11':
        return brand_ad_v11
    if version in {'2026-10-13.7', '2026-10-13.8', '2026-10-13.9', '2026-10-13.10'}:
        if route == 'BRAND_AD':
            return brand_ad_v7
        if route == 'DRAMA':
            return drama_v7
    if version in {'2026-10-13.4', '2026-10-13.5', '2026-10-13.6'}:
        if route == 'BRAND_AD':
            return brand_ad
        if route == 'DRAMA':
            return drama
    if route == 'BRAND_AD' and version == '2026-10-13.1':
        return brand_ad_v1
    if route == 'BRAND_AD' and version in {'2026-10-13.2', '2026-10-13.3'}:
        return brand_ad_v3
    if route == 'DRAMA' and version in {'2026-10-13.1', '2026-10-13.2', '2026-10-13.3'}:
        return drama_v3
    return STRATEGIES[route]
