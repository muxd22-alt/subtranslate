# Shared POSIX helpers for the subfind/subsync/subtr wrappers.
# Sourced by the wrapper scripts; no side effects beyond function definitions.

st_die() { printf '%s: %s\n' "${ST_PROG:-subtranslate}" "$*" >&2; exit 1; }
st_say() { printf '%s\n' "$*"; }
st_warn() { printf '%s: warning: %s\n' "${ST_PROG:-subtranslate}" "$*" >&2; }

st_have() { command -v "$1" >/dev/null 2>&1; }

st_is_srt() {
    [ -f "$1" ] && [ -s "$1" ] && grep -q -- '-->' "$1" 2>/dev/null
}

# Arabic script is UTF-8 0xD8-0xDB. grep in the C locale compares bytes, so this
# works even when the shell locale is not UTF-8.
st_has_arabic() {
    [ -f "$1" ] || return 1
    _st_byte=$(printf '\330')
    LC_ALL=C grep -q "$_st_byte" "$1" 2>/dev/null && return 0
    _st_byte=$(printf '\331')
    LC_ALL=C grep -q "$_st_byte" "$1" 2>/dev/null && return 0
    _st_byte=$(printf '\332')
    LC_ALL=C grep -q "$_st_byte" "$1" 2>/dev/null && return 0
    _st_byte=$(printf '\333')
    LC_ALL=C grep -q "$_st_byte" "$1" 2>/dev/null && return 0
    return 1
}

st_has_latin() {
    [ -f "$1" ] && LC_ALL=C grep -q '[A-Za-z]' "$1" 2>/dev/null
}

# Path to the media file without its extension.
st_video_base() {
    case "$1" in
        *.srt|*.SRT)
            printf '%s' "$1" | sed -E 's/\.([Aa][Rr]|[Aa][Rr][Aa]|[Aa][Rr][Aa][Bb][Ii][Cc]|[Ee][Nn]|[Ee][Nn][Gg]|[Ee][Nn][Gg][Ll][Ii][Ss][Hh])(\.([Ss][Uu][Bb]|[Tt][Rr][Aa][Nn]|[Ff][Oo][Rr][Cc][Ee][Dd]|[Ss][Dd][Hh]|[Hh][Ii]|[Cc][Cc]))?\.[Ss][Rr][Tt]$//; s/\.[Ss][Rr][Tt]$//'
            ;;
        *)
            printf '%s' "${1%.*}"
            ;;
    esac
}

# "%s" -> a human title; pass the base path (no media extension).
st_title() {
    basename "$1" | sed -e 's/[._]\+/ /g' -e 's/  */ /g' -e 's/^ //' -e 's/ $//'
}

st_find_video() { # base
    for ext in mkv mp4 m4v avi mov wmv flv webm mpg mpeg ts MKV MP4 M4V AVI MOV WMV FLV WEBM MPG MPEG TS; do
        [ -f "$1.$ext" ] && { printf '%s' "$1.$ext"; return 0; }
    done
    return 1
}

# Prints "<path>|tagged" or "<path>|untagged" for a usable English subtitle.
st_find_en() { # base
    for cand in "$1.en.srt" "$1.eng.srt" "$1.english.srt" "$1.en.forced.srt" "$1.en.sdh.srt"; do
        if st_is_srt "$cand" && ! st_has_arabic "$cand"; then
            printf '%s|tagged' "$cand"
            return 0
        fi
    done
    # Releases from YTS and friends often ship a plain .srt. It is only a
    # candidate when it does not contain Arabic.
    if st_is_srt "$1.srt" && ! st_has_arabic "$1.srt"; then
        printf '%s|untagged' "$1.srt"
        return 0
    fi
    return 1
}

st_tmpdir() {
    if [ -n "${TMPDIR:-}" ] && [ -d "$TMPDIR" ]; then
        _st_base=$TMPDIR
    elif [ -n "${HOME:-}" ] && [ -d "$HOME" ]; then
        _st_base=$HOME/.cache
    else
        _st_base=.
    fi
    mkdir -p "$_st_base" 2>/dev/null || _st_base=.
    mktemp -d "$_st_base/subtranslate.XXXXXX" 2>/dev/null || {
        _st_dir="$_st_base/subtranslate.$$"
        mkdir -p "$_st_dir" && printf '%s' "$_st_dir"
    }
}

st_atomic_copy() { # src dest
    _st_dst=$2
    _st_tmp="$_st_dst.$$.part"
    if cp "$1" "$_st_tmp" && mv -f "$_st_tmp" "$_st_dst"; then
        return 0
    fi
    rm -f "$_st_tmp"
    return 1
}

# Downloads a subtitle and prints the path to the .srt.
# Exit codes: 0 found, 3 nothing found, 4 subliminal missing, 1 error.
st_download() { # video lang
    st_have subliminal || return 4
    _st_tmp=$(st_tmpdir) || return 1
    _st_providers=${SUBFIND_PROVIDERS:-${SUBGRAB_PROVIDERS:-opensubtitles}}
    _st_timeout=${SUBFIND_TIMEOUT:-300}

    if st_have timeout; then
        timeout "$_st_timeout" subliminal download -l "$2" -p "$_st_providers" -d "$_st_tmp" "$1" >&2
    else
        subliminal download -l "$2" -p "$_st_providers" -d "$_st_tmp" "$1" >&2
    fi
    _st_rc=$?

    _st_found=$(find "$_st_tmp" -type f \( -iname '*.srt' -o -iname '*.ass' -o -iname '*.vtt' \) 2>/dev/null | head -n 1)
    if [ -z "$_st_found" ]; then
        rm -rf "$_st_tmp"
        [ "$_st_rc" -eq 124 ] && return 1
        return 3
    fi

    case "$_st_found" in
        *.srt|*.SRT) ;;
        *)
            if st_have ffmpeg; then
                ffmpeg -v error -y -i "$_st_found" "$_st_tmp/converted.srt" >&2 || { rm -rf "$_st_tmp"; return 1; }
                _st_found="$_st_tmp/converted.srt"
            else
                rm -rf "$_st_tmp"
                return 4
            fi
            ;;
    esac

    if ! st_is_srt "$_st_found"; then
        rm -rf "$_st_tmp"
        return 3
    fi
    printf '%s' "$_st_found"
    return 0
}
