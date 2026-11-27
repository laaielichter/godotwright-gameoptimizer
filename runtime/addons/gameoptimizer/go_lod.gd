class_name GOLod
extends RefCounted
## Scales visibility ranges (HLOD distances) of everything under a node by one bias.
##
## The authored ranges are kept in the `go_vr` meta of each instance, so the bias never compounds:
## apply_bias(root, 0.5) then apply_bias(root, 1.0) gives the authored ranges back.

const META := &"go_vr"


## Multiplies visibility_range_begin/end (and their margins) of every GeometryInstance3D under `root`.
## Returns the number of instances changed.
static func apply_bias(root: Node, bias: float) -> int:
	if root == null:
		return 0
	bias = maxf(bias, 0.01)
	var changed := 0
	var stack: Array[Node] = [root]
	while not stack.is_empty():
		var node: Node = stack.pop_back()
		if node is GeometryInstance3D:
			var geo := node as GeometryInstance3D
			if geo.has_meta(META) or geo.visibility_range_end > 0.0 or geo.visibility_range_begin > 0.0:
				if not geo.has_meta(META):
					geo.set_meta(META, Vector4(
						geo.visibility_range_begin, geo.visibility_range_end,
						geo.visibility_range_begin_margin, geo.visibility_range_end_margin))
				var authored: Vector4 = geo.get_meta(META)
				geo.visibility_range_begin = authored.x * bias
				geo.visibility_range_end = authored.y * bias
				geo.visibility_range_begin_margin = authored.z * bias
				geo.visibility_range_end_margin = authored.w * bias
				changed += 1
		stack.append_array(node.get_children())
	return changed
