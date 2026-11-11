"""「구현 ① 프로젝트」 실행별 티켓 체크박스 진행 (progress.py)."""

from urllib.parse import parse_qs

from adash.features.impl_progress.progress import collect


def get_progress(h, url):
    q = {k: v[0] for k, v in parse_qs(url.query).items()}
    h.send_json({"projects": collect(run=q.get("run"), term=q.get("term"), launch=q.get("launch"))})
