"""Independently versioned creative strategies; no provider or task state here."""
from types import ModuleType
from . import ecommerce, local_store, brand_ad, drama, brand_ad_v1, brand_ad_v3, drama_v3, brand_ad_v7, drama_v7, brand_ad_v11, drama_v11, brand_ad_v14, brand_ad_v14_2, brand_ad_v14_3, brand_ad_v14_5, brand_ad_v14_6, brand_ad_v14_7

COMMERCE_VERSION = "2026-10-14-presenter.3"
PRESENTER_VERSIONS = {"2026-10-14-presenter.1", "2026-10-14-presenter.2", COMMERCE_VERSION}
COMMERCE_VERSIONS = {"2026-10-14-commerce.1", "2026-10-14-commerce.2", "2026-10-14-commerce.3", "2026-10-14-commerce.4", "2026-10-14-commerce.5", *PRESENTER_VERSIONS}
VERSION = "2026-10-14.7"
DRAMA_VERSION = "2026-10-16-drama.11"
DRAMA_VERSIONS = {'2026-10-14-drama.1', '2026-10-14-drama.2', '2026-10-14-drama.3', '2026-10-16-drama.4', '2026-10-16-drama.5', '2026-10-16-drama.6', '2026-10-16-drama.7', '2026-10-16-drama.8', '2026-10-16-drama.9', '2026-10-16-drama.10', DRAMA_VERSION}
STRATEGIES = {"ECOMMERCE": ecommerce, "LOCAL_STORE": local_store, "BRAND_AD": brand_ad_v14_7, "DRAMA": drama_v11}


def strategy_for(route: str, version: str) -> ModuleType:
    if route == 'DRAMA' and version in DRAMA_VERSIONS:
        if version == DRAMA_VERSION:
            from . import drama_v16_11
            return drama_v16_11
        if version == '2026-10-16-drama.10':
            from . import drama_v16_10
            return drama_v16_10
        if version == '2026-10-16-drama.9':
            from . import drama_v16_9
            return drama_v16_9
        if version == '2026-10-16-drama.8':
            from . import drama_v16_8
            return drama_v16_8
        if version == '2026-10-16-drama.7':
            from . import drama_v16_7
            return drama_v16_7
        if version == '2026-10-16-drama.6':
            from . import drama_v16_6
            return drama_v16_6
        if version == '2026-10-16-drama.5':
            from . import drama_v16_5
            return drama_v16_5
        if version == '2026-10-16-drama.4':
            from . import drama_v16_4
            return drama_v16_4
        if version == '2026-10-14-drama.3':
            from . import drama_v14_3
            return drama_v14_3
        if version == '2026-10-14-drama.2':
            from . import drama_v14_2
            return drama_v14_2
        from . import drama_v14_1
        return drama_v14_1
    if route == 'ECOMMERCE' and version == COMMERCE_VERSION:
        from . import commerce_presenter_v3
        return commerce_presenter_v3
    if route == 'ECOMMERCE' and version == '2026-10-14-presenter.2':
        from . import commerce_presenter_v2
        return commerce_presenter_v2
    if route == 'ECOMMERCE' and version == '2026-10-14-presenter.1':
        from . import commerce_presenter
        return commerce_presenter
    if route == 'ECOMMERCE' and version in {'2026-10-14-commerce.3', '2026-10-14-commerce.4', '2026-10-14-commerce.5'}:
        from . import ecommerce_v3
        return ecommerce_v3
    if route == 'ECOMMERCE' and version == '2026-10-14-commerce.2':
        from . import ecommerce_v2
        return ecommerce_v2
    if route == 'ECOMMERCE' and version == '2026-10-14-commerce.1':
        from . import ecommerce_v1
        return ecommerce_v1
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
