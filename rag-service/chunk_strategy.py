"""Canonical chunking parameters, strategy identity, and chunk token accounting.

`CHUNK_STRATEGY_VERSION` is the value the retrieval stack compares against to
decide whether stored chunks were produced by the splitter that is running now.
It therefore has to stay derived from the parameters actually in use: the
identifier used to spell out "chunk1000-overlap100" by hand while the splitters
passed separate literal `1000`/`100` arguments, so changing the splitter without
editing the string would have left every stale chunk looking current, and no
reindex would ever have been triggered.

This module deliberately imports nothing from the service so both the database
layer and the splitters can share it without an import cycle.
"""

import re

CHUNK_SIZE = 1000
CHUNK_OVERLAP = 100

CHUNK_PARAMETER_SUFFIX = f"chunk{CHUNK_SIZE}-overlap{CHUNK_OVERLAP}"
CHUNK_STRATEGY_VERSION = (
    f"markdown-v4:parent-child:metadata-embedding:{CHUNK_PARAMETER_SUFFIX}"
)

# Identifier for the estimator below. `file_chunks.token_count` stores an
# estimate, not the output of any model's real tokenizer, so the estimator is
# versioned: changing the heuristic changes the meaning of every stored count.
TOKEN_COUNT_ESTIMATOR = "heuristic-cjk-v1"

# Han, Hiragana, Katakana, Hangul and CJK compatibility ranges. Subword
# tokenizers emit roughly one token per codepoint here, whereas alphabetic text
# averages closer to four characters per token.
_DENSE_SCRIPT_PATTERN = re.compile(
    "["
    "\u3040-\u30ff"  # Hiragana, Katakana
    "\u3400-\u4dbf"  # CJK Unified Ideographs Extension A
    "\u4e00-\u9fff"  # CJK Unified Ideographs
    "\uf900-\ufaff"  # CJK Compatibility Ideographs
    "\uac00-\ud7af"  # Hangul Syllables
    "]"
)

_CHARACTERS_PER_TOKEN = 4


def estimate_token_count(text: str) -> int:
    """Estimate the token count of a chunk.

    The embedding and chat providers in use do not expose their tokenizers, so an
    exact count is not obtainable here. This returns a deterministic, provider
    independent approximation suitable for budgeting and observability; treat it
    as an estimate and never as an exact count. `TOKEN_COUNT_ESTIMATOR` names the
    heuristic that produced a stored value.
    """
    if not text:
        return 0
    dense_characters = len(_DENSE_SCRIPT_PATTERN.findall(text))
    remaining_characters = len(text) - dense_characters
    if remaining_characters <= 0:
        return dense_characters
    # Integer ceiling division: a trailing partial word still costs a token.
    return dense_characters + (
        (remaining_characters + _CHARACTERS_PER_TOKEN - 1) // _CHARACTERS_PER_TOKEN
    )
