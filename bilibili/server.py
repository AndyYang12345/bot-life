"""Only public content read tools; login, cookies and account writes are absent."""
import argparse
from mcp.server.fastmcp import FastMCP
from backend import Backend

parser = argparse.ArgumentParser()
parser.add_argument('--credentials', required=True)
args = parser.parse_args()
backend = Backend(args.credentials)
mcp = FastMCP('qqbot-bilibili-readonly', log_level='ERROR')


@mcp.tool()
async def bili_video_info(target: str) -> dict:
    """Read public video metadata from a BV/av ID or Bilibili video/b23 link, preserving ?p=."""
    return await backend.call('bili_video_info', {'target': target})


@mcp.tool()
async def bili_subtitle(target: str, start: int = 0, limit: int = 8000) -> dict:
    """Read timestamped subtitles; next_start indicates unread lines. Not visual or audio analysis."""
    return await backend.call('bili_subtitle', {'target': target, 'start': start, 'limit': limit})


@mcp.tool()
async def bili_video_preview(target: str) -> dict:
    """Sample six frames from a public video up to 10 minutes. No audio; not full visual coverage."""
    return await backend.call('bili_video_preview', {'target': target})


@mcp.tool()
async def bili_search(keyword: str) -> dict:
    """Search public videos; return at most five items, not video contents."""
    return await backend.call('bili_search', {'keyword': keyword})


@mcp.tool()
async def bili_comments(target: str) -> dict:
    """Read at most eight first-page public comments; these are not video content."""
    return await backend.call('bili_comments', {'target': target})


if __name__ == '__main__':
    mcp.run(transport='stdio')
