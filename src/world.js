(function() {

  // World is Backbone model which contains a collection of sprites. Sprites
  // can be added and removed via methods add() and remove(). Sprites are
  // automatically attached to the engine. In each request frame, the same
  // mechanics apply as for sprites attached to the engine; methods update()
  // and draw() are called for each sprite. The exception is for static sprites
  // which are only updated/redrawn when required (see below).
  //
  // A world is measured in tiles via attributes width, height, tileWidth
  // and tileHeight. Call methods width() and height() to get the dimensions
  // in pixels. Attributes x and y determine the origin in pixels (top-left
  // corner) and allow the world to be panned hence changing the viewport.
  //
  // Methods getWorldIndex(), getWorldCol() and getWorldRow() can be used
  // to find the position of a sprite (at its origin, top-left corner).
  // A sprite's x and y attributes determine their position relative to the
  // world origin.
  //
  // Internally, world splits sprites into 2 collections depending on their
  // static attribute:
  //   - StaticSprites: Background sprites that have no animation. These are
  //     assumed to be tiles. They are indexed by their position (column and
  //     row) and only drawn when required (i.e. world is panned). Use method
  //     findCollidingAt() for quick lookup.
  //   - DynamicSprites: Animated tiles and characters. Use methods findAt()
  //     and filterAt() to find collisions with other sprites.
  // If you define a tile, make sure its static attribute is set to true.
  //
  // When the world is created, sprites are instantiated in method spawnSprites.
  // Each sprite instance is attached to the engine. Sprites then have properties
  // engine and world set pointing to those respective objects.
  //
  // Attributes:
  //   - x, y: Origin of top-left corner in pixels.
  //   - width, height: Size of world in tiles
  //   - tileWidth, tileHeight: Size of a tile in pixels.
  //   - hero: Name of sprite character controlled by the user. Will
  //     be passed the input as option when instantiated.
  //   - sprites: Array of sprite models for persistence.
  //   - backgroundColor: Background color of the world.
  //   - state: Persisted state either play or edit.
  //
  // Options:
  //   - backgroundImage: Optional. Pass to use a background image
  //     instead of a background color. Anchored to the origin.
  //   - input: Input instance to control the hero.
  //   - camera: Camera instance to keep the hero in the viewport.
  //   - debugPanel: Optional.
  //
  // Persistence:
  // The world model attributes contain all that is necessary to persist the
  // state of the world to disk, or in the cloud. Persistence is provided
  // using Backbone sync. See the Backbone documentation for details.
  //

  Backbone.IndexedCollection = Backbone.Collection.extend({comparator: "id"});

  Backbone.World = Backbone.Model.extend({
    defaults: {
      x: 0,
      y: 0,
      tileWidth: 32,
      tileHeight: 32,
      width: 100,
      height: 19,
      backgroundColor: "rgba(66, 66, 255, 1)",
      sprites: [], // Copy for persistence only. Use the direct member sprites which is a collection.
      state: "play", // edit or play
      hero: null
    },
    shallowAttributes: ["x", "y", "width", "height", "tileWidth", "tileHeight", "backgroundColor", "hero"],
    urlRoot: "/ludo/world",
    viewport: {x:0, y:0, width:0, height: 0},
    spriteOptions: {offsetX:0, offsetY:0},
    initialize: function(attributes, options) {
      options || (options = {});
      this.backgroundImage = options.backgroundImage;
      this.input = options.input;
      this.camera = options.camera;
      this.debugPanel = options.debugPanel;
      
      _.bindAll(this,
        "save", "getWorldIndex", "getWorldCol", "getWorldRow", "addOrReplace",
        "findAt", "filterAt", "spawnSprites", "height", "width", "add", "remove"
      );

      this.sprites = new Backbone.Collection();
      this.setupBackground();
      this.spawnSprites();

      this.on("attach", this.onAttach, this);
      this.on("detach", this.onDetach, this);
    },
    height: function() {
      return this.get("height") * this.get("tileHeight");
    },
    width: function() {
      return this.get("width") * this.get("tileWidth");
    },
    toShallowJSON: function() {
      return _.pick(this.attributes, this.shallowAttributes);
    },
    onAttach: function() {
      var engine = this.engine;
      this.sprites.each(function(sprite) {
        sprite.engine = engine;
        sprite.trigger("attach", engine);
      });
    },
    onDetach: function() {
      this.sprites.each(function(sprite) {
        sprite.engine = undefined;
        sprite.trigger("detach");
      });
    },

    // Split static sprites (background tiles) from dynamic ones (animated or moving).
    // Draw static on a background and seldomly redraw.
    // Dynamic ones are redrawn every animation frame.
    // Maintain shadow collections to quickly access the two types.
    setupBackground: function() {
      var world = this,
          staticSprites = this.staticSprites = new Backbone.IndexedCollection(),
          dynamicSprites = this.dynamicSprites = new Backbone.Collection();
      staticSprites.lookup = {};

      this.listenTo(this.sprites, "add", function(sprite) {
        if (sprite.get("static")) {
          staticSprites.add(sprite);
          world.updateStaticColumLookup();
        } else {
          dynamicSprites.add(sprite);
        }
      });

      this.listenTo(this.sprites, "reset", function(sprites) {
        staticSprites.reset();
        dynamicSprites.reset();
        sprites.each(function(sprite) {
          if (sprite.get("static"))
            staticSprites.add(sprite);
          else
            dynamicSprites.add(sprite);
        });
        world.updateStaticColumLookup();
      });

      this.listenTo(this.sprites, "remove", function(sprite) {
        if (sprite.get("static")) {
          staticSprites.remove(sprite);
          world.updateStaticColumLookup();
        } else {
          dynamicSprites.remove(sprite);
        }
      });

      this.backgroundCanvas = document.getElementById("background");
      this.backgroundContext = this.backgroundCanvas.getContext("2d");
      drawRect(this.backgroundContext, 0, 0, this.backgroundCanvas.width, this.backgroundCanvas.height, "#000");

      this.on("change", function() {
        this.requestBackgroundRedraw = true;
      });
      return this;
    },

    updateStaticColumLookup: function() {
      var lookup = this.staticSprites.lookup = {};

      // Map each column with the first top-most tile
      this.staticSprites.each(function(sprite, index) {
        var id = sprite.id,
            col = sprite.get("col"),
            row = sprite.get("row");
        if (!lookup[col] || row < lookup[col].row)
          lookup[col] = {
            id: id,
            row: row,
            index: index
          }
      });

      // Ensure each column that has no tiles, points to
      // the next tile in the chain
      var maxCol = this.get("width"),
          tile = null;
      for (var col = maxCol; col >= 0; col--)
        if (lookup[col]) {
          tile = lookup[col];
        } else {
          lookup[col] = tile;
        }

      this.requestBackgroundRedraw = true;

      return this;
    },

    // Create the sprites collection from the sprites attribute.
    spawnSprites: function() {
      var world = this,
          w = this.toShallowJSON(),
          _sprites =  this.get("sprites");

      this.sprites.reset();

      var names = [];
      function buildId(name) {
        var count = 0;
        for (var i=0; i<names.length; i++)
          if (names[i].indexOf(name) == 0) count += 1;
        name += "." + (count + 1);
        names.push(name);
        return name;
      }

      var sprites = _.reduce(_sprites, function(sprites, s) {
        var cls = _.classify(s.name),
            col = world.getWorldCol(s.x),
            row = world.getWorldRow(s.y),
            options = {world: world};

        if (s.name == w.hero) options.input = world.input;

        var id = Backbone[cls].prototype.defaults.type == "character" ? buildId(s.name) : col * w.height + row;
        var newSprite = new Backbone[cls](_.extend(s,
          {
            id: id,
            col: col,
            row: row
          }
        ), options);
        sprites.push(newSprite);
        
        if (s.name == w.hero)
          world.camera.setOptions({world: world, subject: newSprite});

        return sprites;
      }, []);

      this.requestBackgroundRedraw = true;
      this.sprites.reset(sprites);

      return this;
    },

    // When saving, persist the sprite collection in the model attribute sprites.
    save: function() {
      var sprites = this.sprites.map(function(sprite) {
        return sprite.toSave.apply(sprite);
      });

      this.set({
        sprites: sprites,
        savedOn: new Date().toJSON()
      }, {silent: true});

      return Backbone.Model.prototype.save.apply(this, arguments);
    },

    update: function(dt) {
      if (!this.engine) return false;

      var start =_.now(),
          x = this.get("x"),
          y = this.get("y"),
          hero = this.get("hero"),
          tileWidth = this.get("tileWidth"),
          worldWidth = this.get("width") * tileWidth,
          minX = -Math.floor(x) - tileWidth*3,
          maxX = minX + this.engine.canvas.width + tileWidth*6;
      if (minX < 0) minX = 0;
      if (maxX > worldWidth) maxX = worldWidth;
      this.viewport.x = minX;
      this.viewport.y = 0;
      this.viewport.width = maxX - minX;
      this.viewport.height= this.engine.canvas.height;

      // Background
      var minCol = this.getWorldCol(minX),
          maxCol = this.getWorldCol(maxX),
          first = this.staticSprites.lookup[minCol],
          last = this.staticSprites.lookup[maxCol];
      this.staticSprites._drawFrom = first ? first.index : 0;
      this.staticSprites._drawTo = last ? last.index : this.staticSprites.size() - 1;

      if (this.requestBackgroundRedraw) {
        this.requestBackgroundRedraw = false;
        this.drawBackground = true;
      }

      // Foreground
      var sprite;
      for (var i = 0; i < this.dynamicSprites.models.length; i++) {
        sprite = this.dynamicSprites.models[i];
        if (sprite.attributes.name == hero || sprite.overlaps.call(sprite, this.viewport))
          sprite._draw = sprite.update(dt);
      }

      if (this.debugPanel)
        this.debugPanel.set({
          updateTime: _.now()-start,
          ui: {minX:minX, maxX:maxX, from:from, to:to, first:first, last:last}
        });

      this.drawBackground = this.drawBackground || this.lastX != x || this.lastY || y;
      this.lastX = x; this.lastY = y;
      return true;
    },
    draw: function(context) {
      if (this.drawBackground) {
        this.drawStaticSprites(this.backgroundContext);
        this.drawBackground = false;
      }
      this.drawDynamicSprites(context);
      return this;
    },
    drawStaticSprites: function(context) {
      var start =_.now(),
          w = this.toShallowJSON(),
          worldWidth = w.width * w.tileWidth,
          worldHeight = w.height * w.tileHeight;
      this.viewport.x = Math.floor(-w.x);
      this.viewport.y = Math.floor(-w.y);
      this.viewport.width = context.canvas.width;
      this.viewport.height= context.canvas.height;
      this.spriteOptions.offsetX = w.x;
      this.spriteOptions.offsetY = w.y;

      drawRect(
        context,
        Math.floor(w.x > 0 ? w.x : 0),
        Math.floor(w.y > 0 ? w.y : 0),
        worldWidth < this.viewport.width ? worldWidth : this.viewport.width,
        worldHeight < this.viewport.height ? worldHeight : this.viewport.height,
        w.backgroundColor
      );

      if (this.backgroundImage) {
        var img = this.backgroundImage,
            ix = -w.x/2,
            iy = -w.y/2,
            width = this.viewport.width < img.width ? this.viewport.width : img.width,
            height = this.viewport.height < img.height ? this.viewport.height : img.height,
            flipAxis = 0;
        context.save();
        context.translate(flipAxis, 0);
        context.scale(2, 2);
        context.translate(-flipAxis, 0);
        context.drawImage(
          img,
          ix, iy, width, height,
          0, 40, width, height
        );
        context.restore();
      }

      var sprite,
          to = this.staticSprites._drawTo;
      if (to >= this.staticSprites.length) to = this.staticSprites.length-1;
      for (var i = this.staticSprites._drawFrom; i <= to; i++) {
        sprite = this.staticSprites.models[i];
        sprite.draw.call(sprite, context, this.spriteOptions);
      }

      if (this.debugPanel) this.debugPanel.set({
        tilesDrawn: this.staticSprites.toDraw.length,
        staticDrawTime: _.now()-start
      });

      return this;
    },
    drawDynamicSprites: function(context) {
      var start =_.now(),
          w = this.toShallowJSON(),
          worldWidth = w.width * w.tileWidth,
          worldHeight = w.height * w.tileHeight;
      this.spriteOptions.offsetX = w.x;
      this.spriteOptions.offsetY = w.y;

      context.drawImage(this.backgroundCanvas, 0, 0);

      var spritesDrawn = 0,
          sprite;
      for (var i = 0; i < this.dynamicSprites.models.length; i++) {
        sprite = this.dynamicSprites.models[i];
        if (sprite._draw) {
          sprite.draw.call(sprite, context, this.spriteOptions);
          spritesDrawn += 1;
        }
      }

      if (this.debugPanel) this.debugPanel.set({
        spritesDrawn: spritesDrawn,
        dynamicDrawTime: _.now()-start
      });

      return this;
    },

    // Sprites are ided (and ordered) by columns. This allows for
    // fast column drawing without lookup.
    getWorldIndex: function(object) {
      if (!_.isObject(object)) return null;
      var x = object.attributes ? object.get("x") : object.x || 0,
          y = object.attributes ? object.get("y") : object.y || 0,
          col = Math.floor(x / this.get("tileWidth")),
          row = Math.floor(y / this.get("tileHeight"));
      return col * this.get("height") + row;
    },
    getWorldCol: function(x) {
      return Math.floor(x / this.get("tileWidth"));
    },
    getWorldRow: function(y) {
      return Math.floor(y / this.get("tileHeight"));
    },
    findAt: function(x, y, type, exclude, collision) {
      return this._findOrFilter("find", x, y, type, exclude, collision);
    },
    filterAt: function(x, y, type, exclude, collision) {
      return this._findOrFilter("filter", x, y, type, exclude, collision);
    },
    _findOrFilter: function(fn, x, y, type, exclude, collision) {
      var collection = this.sprites,
          id = exclude && exclude.id ? exclude.id : null,
          result;

      function doIt(sprite) {
        return (sprite.id && sprite.id != id) &&
          (!type || sprite.get("type") == type) &&
          (!collision || sprite.get("collision")) &&
          sprite.overlaps.call(sprite, x, y);
      }

      // Look in dynamic sprites first
      result = this.dynamicSprites[fn](doIt);
      if ((fn == "find" && !_.isEmpty(result)) || type == "character") return result;

      // Finally in static ones
      return fn == "find" ? this.staticSprites[fn](doIt) : _.union(result, this.staticSprites[fn](doIt));
    },
    findCollidingAt:function(x, y) {
      var id = this.getWorldIndex({x: x, y: y}),
          sprite = id ? this.sprites.get(id) : null;
      return sprite && sprite.get("collision") ? sprite : null;
    },
    add: function(sprite) {
      sprite.world = this;
      this.sprites.add.apply(this.sprites, arguments);
    },
    remove: function(sprite) {
      this.sprites.remove.apply(this.sprites, arguments);
      sprite.world = undefined;
    },
    addOrReplace: function(sprite, x, y) {
      var w = this.toShallowJSON(),
          existing = this.findAt(x, y),
          existingName = existing ? existing.get("name") : null,
          spriteName = sprite ? sprite.get("name") : "",
          spriteOptions = {world: this};

      if (!sprite && !existing) return null;

      if (!sprite && existing) {
        this.sprites.remove(existing);
        return null;
      }
      
      if (existing) {
        if (spriteName == existingName) {
          // Toggle if same sprite - either turn around or remove
          var cur = existing.getStateInfo(),
              removeOnDir = existingName == w.hero ? "left" : "right";
          if (!cur.dir || cur.dir == removeOnDir) {
            this.sprites.remove(existing);
            return null;
          }
          existing.toggleDirection(cur.opo);
          return existing;
        } else {
          // Replace existing
          this.sprites.remove(existing);
        }
      }

      // Mario is a singleton - remove if anywhere else
      if (spriteName == w.hero) {
        var hero = this.sprites.findWhere({name: w.hero});
        if (hero) this.sprites.remove(hero);
        spriteOptions.input = this.input;
      }

      var spriteHeight = sprite.get("height"),
          col = this.getWorldCol(x),
          row = this.getWorldRow(y - spriteHeight + w.tileHeight),
          id = sprite.get("type") == "character" ? this.buildId(sprite) : col * w.height + row,
          cls = _.classify(spriteName);
      var newSprite = new Backbone[cls](_.extend({}, sprite.toJSON(), {
        id: id,
        x: col * w.tileWidth,
        y: row * w.tileHeight,
        col: col,
        row: row
      }), spriteOptions);
      this.sprites.add(newSprite);

      if (spriteName == w.hero)
        this.camera.setOptions({world: this, subject: newSprite});

      newSprite.engine = this.engine;
      newSprite.trigger("attach", this.engine);

      return newSprite;
    },
    buildId: function(sprite) {
      var name = sprite.get("name");
          re = new RegExp("^" + name + "\\." + "\\d+$"),
          numbers = this.dynamicSprites.reduce(function(numbers, sprite) {
            if (sprite.id.length && sprite.id.match(re))
              numbers.push(parseInt(sprite.id.replace(name + ".", "")));
            return numbers;
          }, [0]);
      return name + "." + (_.max(numbers) + 1);
    }
  });

}).call(this);