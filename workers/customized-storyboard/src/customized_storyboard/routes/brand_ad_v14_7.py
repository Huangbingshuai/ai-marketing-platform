"""Brand-specific editorial calibration; frozen older strategies remain unchanged."""
from .brand_ad_v14_6 import PLAN, WRITE as BASE_WRITE, REVIEW as BASE_REVIEW
from ..brand_review_calibration import CALIBRATION, CREATIVE_STANDARD
WRITE = BASE_WRITE + '\n' + CREATIVE_STANDARD
REVIEW = BASE_REVIEW + '\n' + CALIBRATION
