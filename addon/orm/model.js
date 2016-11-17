// jscs:disable requireParenthesesAroundArrowParam
import { toCollectionName } from 'ember-cli-mirage/utils/normalize-name';
import extend from '../utils/extend';
import assert from '../assert';
import Collection from './collection';
import HasMany from './associations/has-many';
import BelongsTo from './associations/belongs-to';
import _isEqual from 'lodash/lang/isEqual';

/*
  The Model class. Notes:

  - We need to pass in modelName, because models are created with
    .extend and anonymous functions, so you cannot use
    reflection to find the name of the constructor.
*/

/*
  Constructor
*/
class Model {

  // TODO: schema and modelName now set statically at registration, need to remove
  constructor(schema, modelName, attrs, fks) {
    assert(schema, 'A model requires a schema');
    assert(modelName, 'A model requires a modelName');

    this._schema = schema;
    this.modelName = modelName;
    this.fks = fks || [];
    attrs = attrs || {};

    this._setupAttrs(attrs);
    this._setupRelationships(attrs);

    return this;
  }

  /**
   * Creates or saves the model.
   * @method save
   * @return this
   * @public
   */
  save() {
    let collection = toCollectionName(this.modelName);

    if (this.isNew()) {
      // Update the attrs with the db response
      this.attrs = this._schema.db[collection].insert(this.attrs);

      // Ensure the id getter/setter is set
      this._definePlainAttribute('id');

    } else {
      this._schema.db[collection].update(this.attrs.id, this.attrs);
    }

    this._saveAssociations();

    return this;
  }

  /**
   * Update the record in the db.
   * @method update
   * @param {String} key
   * @param {String} val
   * @return this
   * @public
   */
  update(key, val) {
    let attrs;
    if (key == null) {
      return this;
    }

    if (typeof key === 'object') {
      attrs = key;
    } else {
      (attrs = {})[key] = val;
    }

    Object.keys(attrs).forEach(function(attr) {
      this._definePlainAttribute(attr);
      this[attr] = attrs[attr];
    }, this);

    this.save();

    return this;
  }

  /**
   * Destroys the db record
   * @method destroy
   * @public
   */
  destroy() {
    let collection = toCollectionName(this.modelName);
    this._schema.db[collection].remove(this.attrs.id);
  }

  /**
   * Boolean, true if the model has not been persisted yet to the db.
   *
   * Originally this method simply checked if the model had an id; however,
   * we let people create models with pre-specified ids. So, we have to
   * check whether the record is in the actual databse or not.
   *
   * @method isNew
   * @return {Boolean}
   * @public
   */
  isNew() {
    let hasDbRecord = false;
    let hasId = this.attrs.id !== undefined && this.attrs.id !== null;

    if (hasId) {
      let collectionName = toCollectionName(this.modelName);
      let record = this._schema.db[collectionName].find(this.attrs.id);
      if (record) {
        hasDbRecord = true;
      }
    }

    return !hasDbRecord;
  }

  /**
   * Boolean, opposite of `isNew`
   * @method isSaved
   * @return {Boolean}
   * @public
   */
  isSaved() {
    return !this.isNew();
  }

  /**
   * Reload a model’s data from the database.
   * @method reload
   * @return this
   * @public
   */
  reload() {
    if (this.id) {
      let collection = toCollectionName(this.modelName);
      let attrs = this._schema.db[collection].find(this.id);

      Object.keys(attrs)
        .filter(function(attr) {
          return attr !== 'id';
        })
        .forEach(function(attr) {
          this.attrs[attr] = attrs[attr];
        }, this);
    }

    // Clear temp associations
    this._tempAssociations = {};

    return this;
  }

  toJSON() {
    return this.attrs;
  }

  /**
   * Returns the association for the given key
   *
   * @method associationFor
   * @param key
   * @public
   */
  associationFor(key) {
    return this._schema.associationsFor(this.modelName)[key];
  }

  /**
   * Returns the inverse association, if it exists
   *
   * @method inverseAssociationFor
   * @param key
   * @public
   */
  inverseAssociationFor(key) {
    return this.associationFor(key).inverse();
  }

  associateModelWithKey(model, key) {
    let association = this.associationFor(key);

    if (association instanceof HasMany) {
      let currentModels = this[key].models;
      if (currentModels.indexOf(model) === -1) {
        this[key].add(model);
      }
    }
  }

  disassociateModelWithKey(model, key) {
    let association = this.associationFor(key);

    if (association instanceof HasMany) {
      let fk = association.getForeignKey();
      let i = this[fk].map(key => key.toString()).indexOf(model.id.toString());
      if (i > -1) {
        this.attrs[fk].splice(i, 1);
      }
    }
  }

  // Private

  // _updateInDb(key, val) {
  //   let attrs;
  //   if (key == null) {
  //     return this;
  //   }
  //
  //   if (typeof key === 'object') {
  //     attrs = key;
  //   } else {
  //     (attrs = {})[key] = val;
  //   }
  //
  //   debugger;
  //   this._schema.db[toCollectionName(this.modelName)].update(this.id, attrs);
  // }

  /**
   * model.attrs represents the persistable attributes, i.e. your db
   * table fields.
   * @method _setupAttrs
   * @param attrs
   * @private
   */
  _setupAttrs(attrs) {
    // Verify no undefined associations are passed in
    Object.keys(attrs)
      .filter(key => {
        let value = attrs[key];
        let isModelOrCollection = (value instanceof Model || value instanceof Collection);
        let isArrayOfModels = Array.isArray(value) && value.length && value.every(item => item instanceof Model);

        return isModelOrCollection || isArrayOfModels;
      })
      .forEach(key => {
        let modelOrCollection = attrs[key];

        assert(this.associationKeys.indexOf(key) > -1, `You're trying to create a ${this.modelName} model and you passed in a ${modelOrCollection.toString()} under the ${key} key, but you haven't defined that key as an association on your model.`);
      });

    // Filter out association keys
    let hash = Object.keys(attrs).reduce((memo, key) => {
      if (this.associationKeys.indexOf(key) === -1 && this.associationIdKeys.indexOf(key) === -1) {
        memo[key] = attrs[key];
      }
      return memo;
    }, {});

    // Ensure fks are there
    this.fks.map(function(fk) {
      hash[fk] = attrs[fk] !== undefined ? attrs[fk] : null;
    });

    this.attrs = hash;

    // define plain getter/setters for non-association keys
    Object.keys(hash).forEach(function(attr) {
      if (this.associationKeys.indexOf(attr) === -1 && this.associationIdKeys.indexOf(attr) === -1) {
        this._definePlainAttribute(attr);
      }
    }, this);
  }

  /**
   * Define getter/setter for a plain attribute
   * @method _definePlainAttribute
   * @param attr
   * @private
   */
  _definePlainAttribute(attr) {

    // Ensure the property hasn't already been defined
    let existingProperty = Object.getOwnPropertyDescriptor(this, attr);
    if (existingProperty && existingProperty.get) {
      return;
    }

    // Ensure the attribute is on the attrs hash
    if (!this.attrs.hasOwnProperty(attr)) {
      this.attrs[attr] = null;
    }

    // Define the getter/setter
    Object.defineProperty(this, attr, {
      get() {
        return this.attrs[attr];
      },
      set(val) {
        this.attrs[attr] = val; return this;
      }
    });
  }

  /**
   * Foreign keys get set on attrs directly (to avoid potential recursion), but
   * model references use the setter.
   *
   * We validate foreign keys during instantiation.
   *
   * @method _setupRelationships
   * @param attrs
   * @private
   */
  _setupRelationships(attrs) {
    let foreignKeysHash = Object.keys(attrs).reduce((memo, attr) => {
      if (this.associationIdKeys.indexOf(attr) > -1 || this.fks.indexOf(attr) > -1) {
        memo[attr] = attrs[attr];
      }
      return memo;
    }, {});

    Object.keys(foreignKeysHash).forEach(function(attr) {
      let fk = foreignKeysHash[attr];
      if (fk !== undefined && fk !== null) {
        this._validateForeignKeyExistsInDatabase(attr, fk);
      }

      this.attrs[attr] = fk;
    }, this);

    let associationKeysHash = Object.keys(attrs).reduce((memo, attr) => {
      if (this.associationKeys.indexOf(attr) > -1) {
        memo[attr] = attrs[attr];
      }
      return memo;
    }, {});
    Object.keys(associationKeysHash).forEach(function(attr) {
      this[attr] = associationKeysHash[attr];
    }, this);
  }

  /**
   * Originally we validated this via association.setId method, but it triggered
   * recursion. That method is designed for updating an existing model's ID so
   * this method is needed during instantiation.
   */
  _validateForeignKeyExistsInDatabase(foreignKeyName, foreignKeys) {
    if (Array.isArray(foreignKeys)) {
      let associationModelName = Object.keys(this.hasManyAssociations)
        .map(key => this.hasManyAssociations[key])
        .find(association => association.getForeignKey() === foreignKeyName)
        .modelName;

      let found = this._schema.db[toCollectionName(associationModelName)].find(foreignKeys);
      assert(found.length === foreignKeys.length, `You're instantiating a ${this.modelName} that has a ${foreignKeyName} of ${foreignKeys}, but some of those records don't exist in the database.`);

    } else {
      let associationModelName = Object.keys(this.belongsToAssociations)
        .map(key => this.belongsToAssociations[key])
        .find(association => association.getForeignKey() === foreignKeyName)
        .modelName;

      let found = this._schema.db[toCollectionName(associationModelName)].find(foreignKeys);
      assert(found, `You're instantiating a ${this.modelName} that has a ${foreignKeyName} of ${foreignKeys}, but that record doesn't exist in the database.`);
    }
  }

  /**
   * Update associated children when saving a collection
   *
   * @method _saveAssociations
   * @private
   */
  _saveAssociations() {
    // Need to save parent once more the case of a reflexive one-to-one, since
    // updating our reference also updated theirs.
    // debugger;
    // if (parent && association.isReflexiveOneToOne()) {
    //   parent.save();
    // }
    // if (this._tempParents) {
    //   Object.keys(this._tempParents).forEach(key => {
    //     let tempParent = this._tempParents[key];
    //     delete this._tempParents[key];
    //     tempParent.save();
    //     debugger;
    //   });
    // }
    this._saveBelongsToAssociations();

    this._saveHasManyAssociations();

    //
    // Object.keys(this.hasManyAssociations).forEach(key => {
    //   let association = this.hasManyAssociations[key];
    //   let children = this[key];
    //   children.update(association.getForeignKey(), this.id);
    // });
  }

  _saveBelongsToAssociations() {
    Object.keys(this.belongsToAssociations).forEach(key => {
      let association = this.belongsToAssociations[key];
      let tempParent = this._tempParents && this._tempParents[key];
      let fk = association.getForeignKey();

      if (tempParent !== undefined) {
        delete this._tempParents[key];
        if (tempParent === null) {
          this.update(fk, null);
        } else {
          tempParent.save();
          this.update(fk, tempParent.id);
        }
      }

      // Save inverse
      if (this[fk] && association.inverse()) {
        let inverseFk = association
          .inverse()
          .getForeignKey();

        this._schema.db[toCollectionName(association.modelName)]
          .update(this[fk], { [inverseFk]: this.id });
      }
    });
  }

  _saveHasManyAssociations() {
    Object.keys(this.hasManyAssociations).forEach(key => {
      let association = this.hasManyAssociations[key];
      let inverse = association.inverse();

      if (inverse) {
        this._disassociateFromOldInverses(association);
      }

      this._saveNewChildren(association);

      this._associateWithNewInverses(association);

      // if (this._cachedAssociations && this._cachedAssociations[key]) {
      //   delete this._cachedAssociations[key];
      // }
    });
  }

  _disassociateFromOldInverses(association) {
    let key = association.key;
    let fk = association.getForeignKey();
    let inverse = association.inverse();
    let tempChildren = this._tempAssociations && this._tempAssociations[key];

    if (tempChildren) {
      // Disassociate currently persisted models that are no longer associated
      this._schema[toCollectionName(association.modelName)]
        .find(this.attrs[fk] || []) // TODO: prob should initialize hasMany fks with []
        .models
        .filter(model => !tempChildren.includes(model)) // filter out models that will still be associated
        .forEach(model => {
          model.disassociateModelWithKey(this, inverse.key);
          model.save();
        });
    }
  }

  _saveNewChildren(association) {
    let key = association.key;
    let fk = association.getForeignKey();
    let tempChildren = this._tempAssociations && this._tempAssociations[key];

    if (tempChildren !== undefined) {
      this.__isSavingNewChildren = true;
      delete this._tempAssociations[key];

      tempChildren.models.forEach(child => {
        child.save();
      });

      // this.update(fk, tempChildren.models.map(child => child.id));
      this._updateInDb({ [fk]: tempChildren.models.map(child => child.id) });
      this.__isSavingNewChildren = false;
    }
  }

  _associateWithNewInverses(association) {
    let fk = association.getForeignKey();
    let inverse = association.inverse();

    // Associate new models
    if (inverse && !this.__isSavingNewChildren) {
      this._schema[toCollectionName(association.modelName)]
        .find(this[fk])
        .models
        .forEach(model => {
          let inverseFk = inverse.getForeignKey();
          let ownerId = this.id;
          let inverseCollection = this._schema.db[toCollectionName(model.modelName)];
          let currentIdsForInverse = inverseCollection.find(model.id)[inverse.getForeignKey()] || [];
          let newIdsForInverse = currentIdsForInverse;

          if (newIdsForInverse.indexOf(ownerId) === -1) {
            newIdsForInverse.push(ownerId);
          }

          inverseCollection.update(model.id, { [inverseFk]: newIdsForInverse });
          // debugger;
          // model.associateModelWithKey(this, inverse.key);
          // model.save();
        });

    }
  }

  // Used to update data directly, since #update retriggers a save which could
  // cause cycles with associations.
  _updateInDb(attrs) {
    this.attrs = this._schema.db[toCollectionName(this.modelName)].update(this.attrs.id, attrs);
  }

  /**
   * Simple string representation of the model and id.
   * @method toString
   * @return {String}
   * @public
   */
  toString() {
    return `model:${this.modelName}(${this.id})`;
  }
}

Model.extend = extend;
Model.findBelongsToAssociation = function(associationType) {
  return this.prototype.belongsToAssociations[associationType];
};

export default Model;
