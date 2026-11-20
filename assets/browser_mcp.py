"""Small stdio MCP adapter for the portable browser bridge; standard library only."""
import json
import re
from pathlib import Path
import sys
import urllib.request

TASK = {'type': 'string', 'description': '本次任务 ID，必须使用当前开发者指令给出的值。'}
TOOLS = [
    ('browser_open', '打开用户 Chrome/Edge 中的采集标签页，复用登录状态。返回可见页面快照；遇到登录/验证请用户接管，禁止绕过。', {'url': {'type': 'string'}}, ['url']),
    ('browser_read', '读取当前采集页面的已加载正文、评论及笔记链接。不读取 cookie，不调用隐藏接口。', {}, []),
    ('browser_action', '对当前采集页面点击/输入/滚动。ref 来自最新快照，滚动后重新读取。', {'action': {'enum': ['click', 'fill', 'scroll']}, 'ref': {'type': 'integer'}, 'text': {'type': 'string'}, 'direction': {'enum': ['down', 'up']}}, ['action']),
    ('browser_screenshot', '将当前浏览器视口截图保存到本次成果目录。', {}, []),
    ('browser_collect', '批量收集给定小红书笔记链接的已加载正文、评论及截图，逐页保存并断点续采。先搜到主题相关链接再调用；每批最多10篇，单篇最多20屏。评论只代表实际加载范围。', {'urls': {'type': 'array', 'items': {'type': 'string'}, 'maxItems': 10}, 'commentPages': {'type': 'integer', 'minimum': 1, 'maximum': 20}}, ['urls']),
]


def main(connection):
    for line in sys.stdin:
        try:
            req = json.loads(line)
            if 'id' not in req:
                continue
            method = req.get('method')
            if method == 'initialize':
                result = {'protocolVersion': req.get('params', {}).get('protocolVersion', '2024-11-05'), 'capabilities': {'tools': {}}, 'serverInfo': {'name': 'portable-browser', 'version': '1.3.0'}}
            elif method == 'ping':
                result = {}
            elif method == 'tools/list':
                result = {'tools': [{'name': name, 'description': description, 'inputSchema': {'type': 'object', 'properties': {'taskId': TASK, **properties}, 'required': ['taskId', *required], 'additionalProperties': False}} for name, description, properties, required in TOOLS]}
            elif method == 'tools/call':
                settings = {}
                try:
                    params = req.get('params', {})
                    settings = json.loads(Path(connection).read_text(encoding='utf-8'))
                    payload = json.dumps({'tool': params.get('name'), **params.get('arguments', {})}, ensure_ascii=False).encode('utf-8')
                    request = urllib.request.Request(settings['endpoint'], data=payload, headers={'Authorization': 'Bearer ' + settings['token'], 'Content-Type': 'application/json'})
                    # The local bridge must never go through a system proxy.
                    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=175) as response:
                        value = json.load(response)
                    result = {'content': [{'type': 'text', 'text': json.dumps(value.get('result', value.get('error')), ensure_ascii=False)}], 'isError': 'error' in value}
                except Exception as error:
                    detail = str(error)
                    if settings.get('token'):
                        detail = detail.replace(settings['token'], '[REDACTED]')
                    detail = re.sub(r'Bearer\s+\S+', 'Bearer [REDACTED]', detail, flags=re.I)
                    result = {'content': [{'type': 'text', 'text': '浏览器操作未完成：' + type(error).__name__ + (('：' + detail[:360]) if detail else '') + '。如需登录或验证，请在浏览器中自行处理。'}], 'isError': True}
            else:
                print(json.dumps({'jsonrpc': '2.0', 'id': req['id'], 'error': {'code': -32601, 'message': 'Method not supported'}}), flush=True)
                continue
            print(json.dumps({'jsonrpc': '2.0', 'id': req['id'], 'result': result}, ensure_ascii=False), flush=True)
        except Exception:
            print(json.dumps({'jsonrpc': '2.0', 'id': None, 'error': {'code': -32700, 'message': 'Invalid request'}}), flush=True)


if __name__ == '__main__':
    main(sys.argv[1])
