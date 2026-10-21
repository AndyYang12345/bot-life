"""Private stdio CPU embedding worker. Runtime is strictly offline."""
import argparse
import collections
import json
import math
import os
import sys
import time

MODEL = 'BAAI/bge-small-zh-v1.5'
POSITIVE = ['你在吗，想请你帮个忙', '问你呢，能回答一下吗', '你刚才说的那个怎么操作', '接着你刚才的回答，还有一个问题']
NEGATIVE = ['我在和另外一个群友聊天', '大家在讨论这个机器人，没有在叫它', '随便说一句，不用回复', '这句话是发给其他人的']


def validate(request):
    if not isinstance(request, dict) or set(request) - {'id', 'text', 'context', 'ping'}:
        raise ValueError('invalid_request')
    if not isinstance(request.get('id'), str) or len(request['id']) > 80:
        raise ValueError('invalid_request')
    if request.get('ping') is True:
        return '', []
    text, context = request.get('text'), request.get('context', [])
    if not isinstance(text, str) or not text.strip() or len(text) > 600 or not isinstance(context, list) or len(context) > 2:
        raise ValueError('invalid_request')
    if any(not isinstance(item, str) or len(item) > 800 for item in context):
        raise ValueError('invalid_request')
    return text, context


def serve(model, device):
    cache = collections.OrderedDict()

    def vector(text):
        if text not in cache:
            value = next(iter(model.embed([text]))).tolist()
            if len(value) != 512 or not all(math.isfinite(x) for x in value):
                raise ValueError('invalid_embedding')
            norm = math.sqrt(sum(x*x for x in value))
            if norm < 1e-8:
                raise ValueError('invalid_embedding')
            cache[text] = [x/norm for x in value]
        cache.move_to_end(text)
        result = cache[text]
        while len(cache) > 128:
            cache.popitem(last=False)
        return result

    def similarity(query, texts):
        return max((sum(a*b for a, b in zip(query, vector(t))) for t in texts if t.strip()), default=0)

    for text in POSITIVE + NEGATIVE:
        vector(text)
    for line in sys.stdin:
        request = {}
        try:
            if len(line) > 12000:
                raise ValueError('request_too_large')
            request = json.loads(line)
            text, context = validate(request)
            started = time.monotonic()
            result = {'model': MODEL, 'dimensions': 512, 'device': device}
            if text:
                query = vector(text)
                result.update(positive=similarity(query, POSITIVE), negative=similarity(query, NEGATIVE), context=similarity(query, context))
            result['elapsed_ms'] = round((time.monotonic()-started)*1000, 2)
            response = {'id': request['id'], 'ok': True, 'result': result}
        except Exception:
            response = {'id': request.get('id') if isinstance(request, dict) else None, 'ok': False, 'error': 'embedding_request_failed'}
        print(json.dumps(response), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--cache-dir', required=True)
    parser.add_argument('--download', action='store_true')
    parser.add_argument('--device', choices=('cpu', 'cuda'), default='cpu')
    args = parser.parse_args()
    if args.download:
        for name in ('ALL_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'all_proxy', 'http_proxy', 'https_proxy'):
            if os.environ.get(name, '').startswith('socks://'):
                os.environ[name] = os.environ[name].replace('socks://', 'socks5://', 1)
    if not args.download:
        os.environ['HF_HUB_OFFLINE'] = '1'
    from fastembed import TextEmbedding
    providers = ['CPUExecutionProvider']
    if args.device == 'cuda':
        import onnxruntime as ort
        if hasattr(ort, 'preload_dlls'):
            ort.preload_dlls()
        if 'CUDAExecutionProvider' not in ort.get_available_providers():
            raise RuntimeError('CUDA provider unavailable')
        providers = ['CUDAExecutionProvider', 'CPUExecutionProvider']
    model = TextEmbedding(model_name=MODEL, cache_dir=args.cache_dir, threads=2,
                          local_files_only=not args.download, providers=providers)
    if args.download:
        next(iter(model.embed(['模型安装验证'])))
        print(json.dumps({'model': MODEL, 'downloaded': True, 'dimensions': 512}))
    else:
        if args.device == 'cuda':
            next(iter(model.embed(['GPU加载验证'])))
            if 'CUDAExecutionProvider' not in model.model.model.get_providers():
                raise RuntimeError('CUDA session did not start')
        serve(model, args.device)
