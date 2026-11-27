extends Node
## Autoload `GOSpawnQueue`: adds nodes to the tree a few per frame, so a wave of spawns never makes one long frame.

## Milliseconds per frame this queue may spend on instantiate + add_child.
@export var budget_ms: float = 1.5

var _queue: Array[Dictionary] = []
var _loading: Array[Dictionary] = []


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	set_process(false)


## Queues `node_or_packed` (a Node or a PackedScene) to be added under `parent`.
## `callback` is called with the node once it is in the tree.
func add(parent: Node, node_or_packed: Variant, callback: Callable = Callable()) -> void:
	_queue.append({"parent": parent, "what": node_or_packed, "callback": callback})
	set_process(true)


## Loads the scene at `path` on a loader thread, then instantiates and adds it under `parent` within the budget.
func instantiate_async(path: String, parent: Node, callback: Callable = Callable()) -> void:
	var err := ResourceLoader.load_threaded_request(path, "PackedScene")
	if err != OK:
		push_error("GOSpawnQueue: cannot load %s (error %d)" % [path, err])
		return
	_loading.append({"path": path, "parent": parent, "callback": callback})
	set_process(true)


## Number of spawns still waiting (queued or loading).
func pending() -> int:
	return _queue.size() + _loading.size()


func _process(_delta: float) -> void:
	var i := 0
	while i < _loading.size():
		var job: Dictionary = _loading[i]
		var status := ResourceLoader.load_threaded_get_status(job["path"])
		if status == ResourceLoader.THREAD_LOAD_IN_PROGRESS:
			i += 1
			continue
		_loading.remove_at(i)
		if status == ResourceLoader.THREAD_LOAD_LOADED:
			_queue.append({"parent": job["parent"], "what": ResourceLoader.load_threaded_get(job["path"]), "callback": job["callback"]})
		else:
			push_error("GOSpawnQueue: loading %s failed" % job["path"])
	var start := Time.get_ticks_usec()
	var budget_usec := int(budget_ms * 1000.0)
	while not _queue.is_empty():
		var item: Dictionary = _queue.pop_front()
		var parent: Variant = item["parent"]
		var what: Variant = item["what"]
		if not is_instance_valid(parent):
			if what is Node and is_instance_valid(what) and not (what as Node).is_inside_tree():
				(what as Node).queue_free()
			continue
		var node: Node = null
		if what is PackedScene:
			node = (what as PackedScene).instantiate()
		elif what is Node and is_instance_valid(what):
			node = what
		if node == null:
			continue
		(parent as Node).add_child(node)
		var callback: Callable = item["callback"]
		if callback.is_valid():
			callback.call(node)
		if Time.get_ticks_usec() - start >= budget_usec:
			break
	if _queue.is_empty() and _loading.is_empty():
		set_process(false)
